import express from "express";
import request from "supertest";
import supertest from "supertest";
import { EMAIL_CODE_RESEND_SECONDS } from "../constants/limits";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    register,
    requestPasswordReset,
    resendRegistrationCode
} from "../controllers/authentication";
import { changeEmail } from "../controllers/users";
import * as pendingRegistrations from "../database/pendingRegistrations";
import { PendingRegistrationModel, registrationCodeScope } from "../database/pendingRegistrations";
import * as users from "../database/users";
import { UserModel, emailChangeScope, passwordResetScope } from "../database/users";
import { createEmailCode, hashEmailCode, issueEmailCode } from "../helpers/emailCodes";
import * as mail from "../helpers/mail";
import { sessionCookie } from "../helpers/session";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    randomHex,
    registerRequest,
    sessionTokenOf,
    setRegistrationCode,
    testEmailOf,
    verifyRegistration
} from "./helpers/testUsers";

interface FakeResponse {
    status: jest.Mock;
    json: jest.Mock;
    set: jest.Mock;
    locals: Record<string, unknown>;
}

const fakeResponse = (): FakeResponse => {
    const res = { locals: {} } as FakeResponse;
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    return res;
};

const run = async (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown,
    req: object,
    res: FakeResponse = fakeResponse(),
    next: jest.Mock = jest.fn()
): Promise<FakeResponse> => {
    await handler(req as express.Request, res as unknown as express.Response, next);
    return res;
};

const failMail = (): jest.SpyInstance =>
    jest.spyOn(mail, "sendMail").mockRejectedValue(new Error("connect ECONNREFUSED"));

const failMailAfter = (meanwhile: () => Promise<unknown>): void => {
    jest.spyOn(mail, "sendMail").mockImplementation(async (): Promise<void> => {
        await meanwhile();
        throw new Error("connect ECONNREFUSED");
    });
};

const expectResent = (res: FakeResponse): void => {
    expect(res.status.mock.calls).toEqual([[200]]);
    expect(res.json.mock.calls).toEqual([
        [{ message: Responses.Authentication.registrationCodeResent }]
    ]);
};

const expectBudgetRefusal = (res: FakeResponse): void => {
    const retryAfter: number = res.json.mock.calls[0][0].retryAfter;

    expect(res.status.mock.calls).toEqual([[503]]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(res.json.mock.calls).toEqual([
        [{ error: Responses.EmailCodes.mailBudgetUsedUp, retryAfter, reason: "mailBudget" }]
    ]);
    expect(res.set.mock.calls).toEqual([["Retry-After", String(retryAfter)]]);
};

const expectPlainMailFailure = (res: FakeResponse): void => {
    expect(res.status.mock.calls).toEqual([[503]]);
    expect(res.json.mock.calls).toEqual([[{ error: Responses.EmailCodes.mailFailed }]]);
    expect(res.set).not.toHaveBeenCalled();
};

const cooldownPassed = (): Date => new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000);

const someFailures = () => ({ count: 7, since: new Date(Date.now() - 60 * 60 * 1000) });

const storedFailures = async (user: TestUser) =>
    (
        await UserModel.findById(user.id)
            .select("+authentication.passwordResetFailures +authentication.emailChangeFailures")
            .lean()
    )?.authentication;

const pendingRegistrationOf = (email: string) => PendingRegistrationModel.findOne({ email }).lean();

const storedReset = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.passwordReset").lean())
        ?.authentication?.passwordReset;

const storedChange = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.emailChange").lean())?.authentication
        ?.emailChange;

const currentUser = async (user: TestUser) =>
    (await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(200)).body;

describe("Failed Code E-mail Tests", (): void => {
    beforeEach((): void => {
        jest.spyOn(console, "error").mockImplementation((): void => undefined);
    });

    afterEach((): void => {
        jest.restoreAllMocks();
    });

    describe("register", (): void => {
        const registrationOf = (username: string) => ({
            username,
            email: testEmailOf(username),
            password: randomHex(12)
        });

        const mailedRegistration = async (username: string): Promise<string> => {
            const email: string = testEmailOf(username);

            await registerRequest(registrationOf(username)).expect(202);
            const code: string = await setRegistrationCode(email);
            await PendingRegistrationModel.updateOne(
                { email },
                { $set: { "code.sentAt": cooldownPassed() } }
            );

            return code;
        };

        it("should mail the code as registration mail", async (): Promise<void> => {
            const body = registrationOf(`mf${randomHex(5)}`);
            const send: jest.SpyInstance = failMail();

            await run(register, { body });

            expect(send.mock.calls).toEqual([
                [expect.objectContaining({ to: body.email, registration: true }), undefined]
            ]);
        });

        describe("once the daily budget refuses the send", (): void => {
            const failBudget = (): jest.SpyInstance =>
                jest
                    .spyOn(mail, "sendMail")
                    .mockRejectedValue(new mail.MailBudgetError("Daily e-mail limit used up"));

            it("should answer with the budget's reason and retryAfter", async (): Promise<void> => {
                failBudget();

                const res: FakeResponse = await run(register, {
                    body: registrationOf(`mf${randomHex(5)}`)
                });

                expectBudgetRefusal(res);
            });

            it("should answer the same for a taken address", async (): Promise<void> => {
                const taken: TestUser = await createTestUser("mf");
                failBudget();

                const res: FakeResponse = await run(register, {
                    body: { ...registrationOf(`mf${randomHex(5)}`), email: taken.email }
                });

                expectBudgetRefusal(res);
                expect(await pendingRegistrationOf(taken.email)).toBeNull();
            });

            it("should restore the earlier registration like any failed send", async (): Promise<void> => {
                const username: string = `mf${randomHex(5)}`;
                const email: string = testEmailOf(username);
                const code: string = await mailedRegistration(username);
                const earlier = await pendingRegistrationOf(email);
                failBudget();

                const res: FakeResponse = await run(register, {
                    body: { ...registrationOf(`mf${randomHex(5)}`), email }
                });

                expectBudgetRefusal(res);
                expect(await pendingRegistrationOf(email)).toEqual(earlier);
                await verifyRegistration(email, code, username, randomHex(12)).expect(201);
            });

            it("should not keep a new registration whose code was refused", async (): Promise<void> => {
                const body = registrationOf(`mf${randomHex(5)}`);
                failBudget();

                const res: FakeResponse = await run(register, { body });

                expectBudgetRefusal(res);
                expect(await pendingRegistrationOf(body.email)).toBeNull();
                await registerRequest(body).expect(202);
            });

            it("should keep any other failed send without a reason", async (): Promise<void> => {
                failMail();

                const res: FakeResponse = await run(register, {
                    body: registrationOf(`mf${randomHex(5)}`)
                });

                expectPlainMailFailure(res);
            });
        });

        it("should resend the code as registration mail", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            const send: jest.SpyInstance = failMail();

            await run(resendRegistrationCode, { body: { email } });

            expect(send.mock.calls).toEqual([
                [expect.objectContaining({ to: email, registration: true }), { reserved: false }]
            ]);
        });

        it("should answer a failed send to a taken address like a free one", async (): Promise<void> => {
            const taken: TestUser = await createTestUser("mf");
            failMail();

            const res: FakeResponse = await run(register, {
                body: { ...registrationOf(`mf${randomHex(5)}`), email: taken.email }
            });

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({ error: Responses.EmailCodes.mailFailed });
            expect(await pendingRegistrationOf(taken.email)).toBeNull();
        });

        it("should not keep a new registration whose code wasn't sent", async (): Promise<void> => {
            const body = registrationOf(`mf${randomHex(5)}`);
            failMail();

            const res: FakeResponse = await run(register, { body });

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({ error: Responses.EmailCodes.mailFailed });
            expect(await pendingRegistrationOf(body.email)).toBeNull();
            await registerRequest(body).expect(202);
        });

        it("should keep the earlier registration and its mailed code", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            const code: string = await mailedRegistration(username);
            const earlier = await pendingRegistrationOf(email);
            failMail();

            const res: FakeResponse = await run(register, {
                body: { ...registrationOf(`mf${randomHex(5)}`), email }
            });

            expect(res.status).toHaveBeenCalledWith(503);
            expect(await pendingRegistrationOf(email)).toEqual(earlier);

            const response: supertest.Response = await verifyRegistration(
                email,
                code,
                username,
                randomHex(12)
            ).expect(201);
            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(username)
            );
        });

        it("should not restore the credentials an earlier registration from before kept", async (): Promise<void> => {
            const email: string = testEmailOf(`mf${randomHex(5)}`);
            const code = {
                hash: randomHex(32),
                sentAt: cooldownPassed(),
                expiresAt: new Date(Date.now() + 60 * 1000),
                attempts: 0
            };
            await PendingRegistrationModel.collection.insertOne({
                email,
                username: `mf${randomHex(5)}`,
                authentication: { salt: randomHex(8), password: randomHex(32) },
                code,
                expiresAt: new Date(Date.now() + 60 * 1000)
            });
            failMail();

            const res: FakeResponse = await run(register, {
                body: { ...registrationOf(`mf${randomHex(5)}`), email }
            });

            expect(res.status).toHaveBeenCalledWith(503);
            const restored = await PendingRegistrationModel.collection.findOne({ email });
            expect(restored).toMatchObject({ email, code });
            expect(restored).not.toHaveProperty("username");
            expect(restored).not.toHaveProperty("authentication");
        });

        it("should keep the mailed code when the resend fails, answering 200 anyway", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            const code: string = await mailedRegistration(username);
            failMail();

            const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });
            const retry: FakeResponse = await run(resendRegistrationCode, { body: { email } });

            expectResent(res);
            expectResent(retry);
            expect(console.error).toHaveBeenCalledTimes(2);
            await verifyRegistration(email, code).expect(201);
        });

        it("should keep the wrong-code count when a re-registration or resend fails", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            await PendingRegistrationModel.updateOne(
                { email },
                { $set: { failures: someFailures() } }
            );
            const earlier = await pendingRegistrationOf(email);
            failMail();

            const reregistered: FakeResponse = await run(register, {
                body: { ...registrationOf(`mf${randomHex(5)}`), email }
            });
            const resent: FakeResponse = await run(resendRegistrationCode, { body: { email } });

            expect(reregistered.status).toHaveBeenCalledWith(503);
            expectResent(resent);
            expect(await pendingRegistrationOf(email)).toEqual(earlier);
        });

        const sendNewerCodeMeanwhile = (email: string): string => {
            const newerCode: string = createEmailCode();

            failMailAfter(() =>
                PendingRegistrationModel.updateOne(
                    { email },
                    { $set: { code: issueEmailCode(registrationCodeScope(email), newerCode, 15) } }
                )
            );

            return newerCode;
        };

        it("should not undo a newer code sent meanwhile", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            const newerCode: string = sendNewerCodeMeanwhile(email);

            const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });

            expectResent(res);
            await verifyRegistration(email, newerCode).expect(201);
        });

        it("should not delete a new registration sent meanwhile", async (): Promise<void> => {
            const body = registrationOf(`mf${randomHex(5)}`);
            const newerCode: string = sendNewerCodeMeanwhile(body.email);

            const res: FakeResponse = await run(register, { body });

            expect(res.status).toHaveBeenCalledWith(503);
            await verifyRegistration(body.email, newerCode).expect(201);
        });

        it("should not undo a newer registration sent meanwhile", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            const newerCode: string = sendNewerCodeMeanwhile(email);

            const res: FakeResponse = await run(register, {
                body: { ...registrationOf(`mf${randomHex(5)}`), email }
            });

            expect(res.status).toHaveBeenCalledWith(503);
            await verifyRegistration(email, newerCode).expect(201);
        });

        it("should not undo a newer send of the same code", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            const newerSentAt: Date = new Date(Date.now() + 1000);
            let newerHash: string;

            failMailAfter(async (): Promise<unknown> => {
                newerHash = (await pendingRegistrationOf(email))?.code?.hash;
                return PendingRegistrationModel.updateOne(
                    { email },
                    { $set: { "code.sentAt": newerSentAt } }
                );
            });

            const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });

            expectResent(res);
            expect((await pendingRegistrationOf(email))?.code).toMatchObject({
                hash: newerHash,
                sentAt: newerSentAt
            });
        });

        it("should answer a resend before looking up the address", async (): Promise<void> => {
            let finishLookup: (pending: null) => void;
            const lookingUp: Promise<void> = new Promise((started): void => {
                jest.spyOn(
                    pendingRegistrations,
                    "replacePendingRegistrationCode"
                ).mockImplementation(() => {
                    started();
                    return new Promise((found): void => {
                        finishLookup = found;
                    }) as never;
                });
            });
            const res: FakeResponse = fakeResponse();

            const handled: Promise<FakeResponse> = run(
                resendRegistrationCode,
                { body: { email: testEmailOf(`mf${randomHex(5)}`) } },
                res
            );
            await lookingUp;

            expectResent(res);
            finishLookup(null);
            await handled;
        });

        it("should answer a resend before mailing the code, like any other address", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            const suspended: TestUser = await createTestUser("mf");
            await UserModel.updateOne({ _id: suspended.id }, { $set: { suspendedAt: new Date() } });
            await registerRequest({
                ...registrationOf(`mf${randomHex(5)}`),
                email: suspended.email
            }).expect(202);
            await PendingRegistrationModel.updateOne(
                { email: suspended.email },
                { $set: { "code.sentAt": cooldownPassed() } }
            );
            let finishSend: () => void;
            let send: jest.SpyInstance;
            const sending: Promise<void> = new Promise((started): void => {
                send = jest
                    .spyOn(mail, "sendMail")
                    .mockResolvedValue()
                    .mockImplementationOnce((): Promise<void> => {
                        started();
                        return new Promise((sent): void => {
                            finishSend = sent;
                        });
                    });
            });
            const res: FakeResponse = fakeResponse();

            const handled: Promise<FakeResponse> = run(
                resendRegistrationCode,
                { body: { email } },
                res
            );
            await sending;

            expectResent(res);
            finishSend();
            await handled;

            for (const other of [testEmailOf(`mf${randomHex(5)}`), email, suspended.email]) {
                const answer: FakeResponse = await run(resendRegistrationCode, {
                    body: { email: other }
                });
                expect([answer.status.mock.calls, answer.json.mock.calls]).toEqual([
                    res.status.mock.calls,
                    res.json.mock.calls
                ]);
            }
            expect(send).toHaveBeenCalledTimes(1);
        });

        it("should only log a resend that fails after answering", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            await mailedRegistration(username);
            const failure: Error = new Error("connection lost");
            jest.spyOn(pendingRegistrations, "replacePendingRegistrationCode").mockRejectedValue(
                failure
            );
            const res: FakeResponse = fakeResponse();
            const next: jest.Mock = jest.fn();

            await run(
                resendRegistrationCode,
                { body: { email: testEmailOf(username) } },
                res,
                next
            );

            expectResent(res);
            expect(next).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith("Registration code not resent:", failure);
        });

        it("should reserve one budget slot before answering a resend, whatever the address", async () => {
            const username: string = `mf${randomHex(5)}`;
            const waiting: string = testEmailOf(username);
            await mailedRegistration(username);
            const cooling = registrationOf(`mf${randomHex(5)}`);
            await registerRequest(cooling).expect(202);
            const suspended: TestUser = await createTestUser("mf");
            await UserModel.updateOne({ _id: suspended.id }, { $set: { suspendedAt: new Date() } });
            await registerRequest({
                ...registrationOf(`mf${randomHex(5)}`),
                email: suspended.email
            }).expect(202);
            await PendingRegistrationModel.updateOne(
                { email: suspended.email },
                { $set: { "code.sentAt": cooldownPassed() } }
            );
            const failingName: string = `mf${randomHex(5)}`;
            const failing: string = testEmailOf(failingName);
            await mailedRegistration(failingName);
            const failure: Error = new Error("connection lost");
            const replace: jest.SpyInstance = jest.spyOn(
                pendingRegistrations,
                "replacePendingRegistrationCode"
            );
            const reserve: jest.SpyInstance = jest
                .spyOn(mail, "reserveRegistrationMail")
                .mockImplementation(() => ({ reserved: true }));
            const send: jest.SpyInstance = jest.spyOn(mail, "sendMail").mockResolvedValue();

            for (const email of [
                waiting,
                testEmailOf(`mf${randomHex(5)}`),
                cooling.email,
                suspended.email,
                failing
            ]) {
                reserve.mockClear();
                if (email === failing) {
                    replace.mockRejectedValueOnce(failure);
                }
                const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });

                expectResent(res);
                expect(reserve.mock.calls).toEqual([[email]]);
                expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
                    res.status.mock.invocationCallOrder[0]
                );
                if (email === waiting) {
                    expect(send.mock.calls[0][0]).toMatchObject({ to: email });
                    expect(send.mock.calls[0][1]).toBe(reserve.mock.results[0].value);
                }
            }
            expect(send).toHaveBeenCalledTimes(1);
            expect(console.error).toHaveBeenCalledWith("Registration code not resent:", failure);
        });

        describe("once registration mail is refused", (): void => {
            const refuseRegistrationMail = (): jest.SpyInstance => {
                jest.spyOn(mail, "reserveRegistrationMail").mockReturnValue(null);
                return jest.spyOn(mail, "sendMail").mockResolvedValue();
            };

            const expectResendRefused = async (email: string): Promise<void> => {
                const earlier = await pendingRegistrationOf(email);
                const send: jest.SpyInstance = refuseRegistrationMail();

                const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });

                expectBudgetRefusal(res);
                expect(send).not.toHaveBeenCalled();
                expect(await pendingRegistrationOf(email)).toEqual(earlier);
            };

            it("should refuse a resend to an address without a registration", async () => {
                await expectResendRefused(testEmailOf(`mf${randomHex(5)}`));
            });

            it("should refuse a resend to a waiting registration the same way", async () => {
                const username: string = `mf${randomHex(5)}`;
                await mailedRegistration(username);

                await expectResendRefused(testEmailOf(username));
            });

            it("should refuse a resend within the cooldown the same way", async () => {
                const body = registrationOf(`mf${randomHex(5)}`);
                await registerRequest(body).expect(202);

                await expectResendRefused(body.email);
            });

            it("should refuse a resend to a suspended account's waiting registration the same way", async () => {
                const suspended: TestUser = await createTestUser("mf");
                await UserModel.updateOne(
                    { _id: suspended.id },
                    { $set: { suspendedAt: new Date() } }
                );
                await registerRequest({
                    ...registrationOf(`mf${randomHex(5)}`),
                    email: suspended.email
                }).expect(202);
                await PendingRegistrationModel.updateOne(
                    { email: suspended.email },
                    { $set: { "code.sentAt": cooldownPassed() } }
                );

                await expectResendRefused(suspended.email);
            });

            it("should answer every refused resend with the same body", async (): Promise<void> => {
                const username: string = `mf${randomHex(5)}`;
                await mailedRegistration(username);
                refuseRegistrationMail();

                const waiting: FakeResponse = await run(resendRegistrationCode, {
                    body: { email: testEmailOf(username) }
                });
                const unknown: FakeResponse = await run(resendRegistrationCode, {
                    body: { email: testEmailOf(`mf${randomHex(5)}`) }
                });

                expectBudgetRefusal(waiting);
                expectBudgetRefusal(unknown);
            });

            it("should still answer a missing address first", async (): Promise<void> => {
                refuseRegistrationMail();

                const res: FakeResponse = await run(resendRegistrationCode, { body: {} });

                expect(res.status).toHaveBeenCalledWith(400);
                expect(mail.reserveRegistrationMail).not.toHaveBeenCalled();
            });
        });
    });

    describe("requestPasswordReset", (): void => {
        const confirmReset = (user: TestUser, code: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/password-reset/confirm")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: user.email, code, newPassword: randomHex(12) });

        const requestResetOf = (
            email: string,
            res?: FakeResponse,
            next?: jest.Mock
        ): Promise<FakeResponse> => run(requestPasswordReset, { body: { email } }, res, next);

        const setResetCode = (user: TestUser, code: string, sentAt: Date) =>
            UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.passwordReset": {
                            hash: hashEmailCode(passwordResetScope(user.id, user.email), code),
                            sentAt,
                            expiresAt: new Date(sentAt.getTime() + 30 * 60 * 1000),
                            attempts: 0
                        }
                    }
                }
            );

        it("should mail the reset code as password reset mail", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const send: jest.SpyInstance = failMail();

            await requestResetOf(user.email);

            expect(send.mock.calls).toEqual([
                [
                    expect.objectContaining({ to: user.email, passwordReset: true }),
                    { reserved: false }
                ]
            ]);
            expect(send.mock.calls[0][0]).not.toHaveProperty("registration");
        });

        it("should answer before mailing the code, like an unknown address", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            let finishSend: () => void;
            const sending: Promise<void> = new Promise((started): void => {
                jest.spyOn(mail, "sendMail").mockImplementation((): Promise<void> => {
                    started();
                    return new Promise((sent): void => {
                        finishSend = sent;
                    });
                });
            });
            const res: FakeResponse = fakeResponse();

            const handled: Promise<FakeResponse> = requestResetOf(user.email, res);
            await sending;

            expect(res.status.mock.calls).toEqual([[200]]);
            expect(res.json.mock.calls).toEqual([
                [{ message: Responses.Authentication.passwordResetSent }]
            ]);
            finishSend();
            await handled;

            const unknown: FakeResponse = await requestResetOf(testEmailOf(`mf${randomHex(5)}`));
            expect([unknown.status.mock.calls, unknown.json.mock.calls]).toEqual([
                res.status.mock.calls,
                res.json.mock.calls
            ]);
        });

        it("should only log a reset that fails after answering", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const failure: Error = new Error("connection lost");
            jest.spyOn(users, "setPasswordReset").mockRejectedValue(failure);
            const res: FakeResponse = fakeResponse();
            const next: jest.Mock = jest.fn();

            await requestResetOf(user.email, res, next);

            expect(res.status.mock.calls).toEqual([[200]]);
            expect(next).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith("Password reset not stored:", failure);
        });

        it("should not keep a reset code that wasn't sent", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            failMail();

            const res: FakeResponse = await requestResetOf(user.email);
            const unknown: FakeResponse = await requestResetOf(testEmailOf(`mf${randomHex(5)}`));

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({
                message: Responses.Authentication.passwordResetSent
            });
            expect(res.json.mock.calls).toEqual(unknown.json.mock.calls);
            expect(await storedReset(user)).toBeUndefined();
        });

        it("should keep the wrong-code count when a reset code wasn't sent", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const failures = someFailures();
            await UserModel.updateOne(
                { _id: user.id },
                { $set: { "authentication.passwordResetFailures": failures } }
            );
            failMail();

            const res: FakeResponse = await requestResetOf(user.email);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(await storedReset(user)).toBeUndefined();
            expect(await storedFailures(user)).toHaveProperty("passwordResetFailures", failures);
        });

        it("should keep the earlier mailed reset code", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const code: string = createEmailCode();
            await setResetCode(user, code, cooldownPassed());
            const earlier = await storedReset(user);
            failMail();

            const res: FakeResponse = await requestResetOf(user.email);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({
                message: Responses.Authentication.passwordResetSent
            });
            expect(await storedReset(user)).toEqual(earlier);
            await confirmReset(user, code).expect(200);
        });

        it("should not undo a newer reset code sent meanwhile", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            await setResetCode(user, createEmailCode(), cooldownPassed());
            const newerCode: string = createEmailCode();
            failMailAfter(() => setResetCode(user, newerCode, new Date()));

            const res: FakeResponse = await requestResetOf(user.email);

            expect(res.status).toHaveBeenCalledWith(200);
            await confirmReset(user, newerCode).expect(200);
        });

        it("should not bring back a reset code voided meanwhile", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            await setResetCode(user, createEmailCode(), cooldownPassed());
            failMailAfter(() =>
                UserModel.updateOne(
                    { _id: user.id },
                    { $unset: { "authentication.passwordReset": 1 } }
                )
            );

            const res: FakeResponse = await requestResetOf(user.email);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(await storedReset(user)).toBeUndefined();
        });

        it("should reserve one budget slot before looking up the address, whatever the address", async () => {
            const existing: TestUser = await createTestUser("mf");
            const cooling: TestUser = await createTestUser("mf");
            await setResetCode(cooling, createEmailCode(), new Date());
            const suspended: TestUser = await createTestUser("mf");
            await UserModel.updateOne({ _id: suspended.id }, { $set: { suspendedAt: new Date() } });
            const reservation: mail.MailReservation = { reserved: true };
            const reserve: jest.SpyInstance = jest
                .spyOn(mail, "reservePasswordResetMail")
                .mockReturnValue(reservation);
            const lookup: jest.SpyInstance = jest.spyOn(users, "getUserByEmail");
            const send: jest.SpyInstance = jest.spyOn(mail, "sendMail").mockResolvedValue();
            const answers: unknown[] = [];

            for (const email of [
                existing.email,
                testEmailOf(`mf${randomHex(5)}`),
                cooling.email,
                suspended.email
            ]) {
                reserve.mockClear();
                lookup.mockClear();
                const res: FakeResponse = await requestResetOf(email);

                answers.push([res.status.mock.calls, res.json.mock.calls]);
                expect(reserve.mock.calls).toEqual([[email]]);
                expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
                    lookup.mock.invocationCallOrder[0]
                );
                expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
                    res.status.mock.invocationCallOrder[0]
                );
            }
            expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0][0]).toMatchObject({
                to: existing.email,
                passwordReset: true
            });
            expect(send.mock.calls[0][1]).toBe(reservation);
        });

        it("should not reserve a budget slot for a blank address", async (): Promise<void> => {
            const reserve: jest.SpyInstance = jest.spyOn(mail, "reservePasswordResetMail");

            const res: FakeResponse = await run(requestPasswordReset, { body: {} });

            expect(res.status).toHaveBeenCalledWith(400);
            expect(reserve).not.toHaveBeenCalled();
        });
    });

    describe("changeEmail", (): void => {
        const changeEmailOf = (user: TestUser, email: string) =>
            run(changeEmail, {
                body: { email, password: user.password },
                identity: { _id: user.id },
                cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
            });

        it("should mail the change code as account mail", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const email: string = testEmailOf(`mf${randomHex(5)}`);
            const send: jest.SpyInstance = failMail();

            await changeEmailOf(user, email);

            expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
            expect(send.mock.calls[0][0]).not.toHaveProperty("registration");
            expect(send.mock.calls[0][0]).not.toHaveProperty("passwordReset");
        });

        test.each([
            [
                "another account's address",
                async (): Promise<string> => (await createTestUser("mf")).email
            ],
            ["SUPERUSER_EMAIL", async (): Promise<string> => TestData.superuser.email]
        ])(
            "should answer a failed send to %s like a free address",
            async (_: string, takenEmail: () => Promise<string>): Promise<void> => {
                const user: TestUser = await createTestUser("mf");
                const email: string = await takenEmail();
                failMail();

                const res: FakeResponse = await changeEmailOf(user, email);

                expect(res.status).toHaveBeenCalledWith(503);
                expect(res.json).toHaveBeenCalledWith({ error: Responses.EmailCodes.mailFailed });
                expect(await storedChange(user)).toBeUndefined();
                expect(await currentUser(user)).toHaveProperty("pendingEmail", null);
            }
        );

        it("should not report a change whose code wasn't sent", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const email: string = testEmailOf(`mf${randomHex(5)}`);
            failMail();

            const res: FakeResponse = await changeEmailOf(user, email);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({ error: Responses.EmailCodes.mailFailed });
            expect(await storedChange(user)).toBeUndefined();
            expect(await currentUser(user)).toHaveProperty("pendingEmail", null);
        });

        const setWaitingChange = (user: TestUser, email: string, code: string, sentAt: Date) =>
            UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.emailChange": {
                            email,
                            hash: hashEmailCode(emailChangeScope(user.id, email), code),
                            sentAt,
                            expiresAt: new Date(sentAt.getTime() + 15 * 60 * 1000),
                            attempts: 0
                        }
                    }
                }
            );

        it("should keep the earlier waiting change and its code", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const waitingEmail: string = testEmailOf(`mf${randomHex(5)}`);
            const code: string = createEmailCode();
            await setWaitingChange(user, waitingEmail, code, cooldownPassed());
            const earlier = await storedChange(user);
            failMail();

            const res: FakeResponse = await changeEmailOf(user, testEmailOf(`mf${randomHex(5)}`));

            expect(res.status).toHaveBeenCalledWith(503);
            expect(await storedChange(user)).toEqual(earlier);
            expect(await currentUser(user)).toHaveProperty("pendingEmail", waitingEmail);

            await request(TestData.apiURL)
                .post("/user/email/confirm")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ code })
                .expect(200);
            expect(await currentUser(user)).toHaveProperty("email", waitingEmail);
        });

        it("should keep the wrong-code count when a change with nothing waiting before wasn't sent", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const failures = someFailures();
            await UserModel.updateOne(
                { _id: user.id },
                { $set: { "authentication.emailChangeFailures": failures } }
            );
            failMail();

            const res: FakeResponse = await changeEmailOf(user, testEmailOf(`mf${randomHex(5)}`));

            expect(res.status).toHaveBeenCalledWith(503);
            expect(await storedChange(user)).toBeUndefined();
            expect(await storedFailures(user)).toHaveProperty("emailChangeFailures", failures);
        });

        test.each([
            ["an earlier waiting change", true],
            ["nothing waiting before", false]
        ])(
            "should not undo a newer change sent meanwhile, with %s",
            async (_: string, waitingBefore: boolean): Promise<void> => {
                const user: TestUser = await createTestUser("mf");
                if (waitingBefore) {
                    await setWaitingChange(
                        user,
                        testEmailOf(`mf${randomHex(5)}`),
                        createEmailCode(),
                        cooldownPassed()
                    );
                }
                const newerEmail: string = testEmailOf(`mf${randomHex(5)}`);
                failMailAfter(() =>
                    setWaitingChange(user, newerEmail, createEmailCode(), new Date())
                );

                const res: FakeResponse = await changeEmailOf(
                    user,
                    testEmailOf(`mf${randomHex(5)}`)
                );

                expect(res.status).toHaveBeenCalledWith(503);
                expect(await storedChange(user)).toHaveProperty("email", newerEmail);
                expect(await currentUser(user)).toHaveProperty("pendingEmail", newerEmail);
            }
        );
    });
});
