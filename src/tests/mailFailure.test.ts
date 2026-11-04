import express from "express";
import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    register,
    requestPasswordReset,
    resendRegistrationCode
} from "../controllers/authentication";
import { changeEmail } from "../controllers/users";
import { PendingRegistrationModel, registrationCodeScope } from "../database/pendingRegistrations";
import { UserModel, emailChangeScope, passwordResetScope } from "../database/users";
import { EMAIL_CODE_RESEND_SECONDS, createEmailCode, hashEmailCode } from "../helpers/emailCodes";
import * as mail from "../helpers/mail";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    randomHex,
    registerRequest,
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
    handler: (req: express.Request, res: express.Response) => unknown,
    req: object
): Promise<FakeResponse> => {
    const res: FakeResponse = fakeResponse();
    await handler(req as express.Request, res as unknown as express.Response);
    return res;
};

const failMail = (): jest.SpyInstance =>
    jest.spyOn(mail, "sendMail").mockRejectedValue(new Error("connect ECONNREFUSED"));

const cooldownPassed = (): Date => new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000);

const pendingRegistrationOf = (email: string) => PendingRegistrationModel.findOne({ email }).lean();

const storedAuthentication = async (user: TestUser) =>
    (
        await UserModel.findById(user.id)
            .select("+authentication.passwordReset +authentication.emailChange")
            .lean()
    ).authentication;

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

            const response: supertest.Response = await verifyRegistration(email, code).expect(201);
            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(username)
            );
        });

        it("should keep the mailed code when the resend fails", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            const code: string = await mailedRegistration(username);
            failMail();

            const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });
            const retry: FakeResponse = await run(resendRegistrationCode, { body: { email } });

            expect(res.status).toHaveBeenCalledWith(503);
            expect(retry.status).toHaveBeenCalledWith(503);
            await verifyRegistration(email, code).expect(201);
        });

        it("should not undo a newer code sent meanwhile", async (): Promise<void> => {
            const username: string = `mf${randomHex(5)}`;
            const email: string = testEmailOf(username);
            await mailedRegistration(username);
            const newerCode: string = createEmailCode();

            jest.spyOn(mail, "sendMail").mockImplementation(async (): Promise<void> => {
                await PendingRegistrationModel.updateOne(
                    { email },
                    {
                        $set: {
                            "code.hash": hashEmailCode(registrationCodeScope(email), newerCode)
                        }
                    }
                );
                throw new Error("connect ECONNREFUSED");
            });

            const res: FakeResponse = await run(resendRegistrationCode, { body: { email } });

            expect(res.status).toHaveBeenCalledWith(503);
            await verifyRegistration(email, newerCode).expect(201);
        });
    });

    describe("requestPasswordReset", (): void => {
        const confirmReset = (user: TestUser, code: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/password-reset/confirm")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: user.email, code, newPassword: randomHex(12) });

        it("should not keep a reset code that wasn't sent", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            failMail();

            const res: FakeResponse = await run(requestPasswordReset, {
                body: { email: user.email }
            });

            expect(res.status).toHaveBeenCalledWith(200);
            expect((await storedAuthentication(user))?.passwordReset).toBeUndefined();
        });

        it("should keep the earlier mailed reset code", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const code: string = createEmailCode();
            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.passwordReset": {
                            hash: hashEmailCode(passwordResetScope(user.id), code),
                            sentAt: cooldownPassed(),
                            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
                            attempts: 0
                        }
                    }
                }
            );
            const earlier = (await storedAuthentication(user)).passwordReset;
            failMail();

            const res: FakeResponse = await run(requestPasswordReset, {
                body: { email: user.email }
            });

            expect(res.status).toHaveBeenCalledWith(200);
            expect((await storedAuthentication(user)).passwordReset).toEqual(earlier);
            await confirmReset(user, code).expect(200);
        });
    });

    describe("changeEmail", (): void => {
        const changeEmailOf = (user: TestUser, email: string) =>
            run(changeEmail, {
                body: { email, password: user.password },
                identity: { _id: user.id }
            });

        it("should not report a change whose code wasn't sent", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const email: string = testEmailOf(`mf${randomHex(5)}`);
            failMail();

            const res: FakeResponse = await changeEmailOf(user, email);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({ error: Responses.EmailCodes.mailFailed });
            expect((await storedAuthentication(user))?.emailChange).toBeUndefined();
            expect(await currentUser(user)).toHaveProperty("pendingEmail", null);
        });

        it("should keep the earlier waiting change and its code", async (): Promise<void> => {
            const user: TestUser = await createTestUser("mf");
            const waitingEmail: string = testEmailOf(`mf${randomHex(5)}`);
            const code: string = createEmailCode();
            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.emailChange": {
                            email: waitingEmail,
                            hash: hashEmailCode(emailChangeScope(user.id, waitingEmail), code),
                            sentAt: cooldownPassed(),
                            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                            attempts: 0
                        }
                    }
                }
            );
            const earlier = (await storedAuthentication(user)).emailChange;
            failMail();

            const res: FakeResponse = await changeEmailOf(user, testEmailOf(`mf${randomHex(5)}`));

            expect(res.status).toHaveBeenCalledWith(503);
            expect((await storedAuthentication(user)).emailChange).toEqual(earlier);
            expect(await currentUser(user)).toHaveProperty("pendingEmail", waitingEmail);

            await request(TestData.apiURL)
                .post("/user/email/confirm")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ code })
                .expect(200);
            expect(await currentUser(user)).toHaveProperty("email", waitingEmail);
        });
    });
});
