import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel, emailChangeScope, passwordResetScope } from "../database/users";
import { PendingRegistrationModel } from "../database/pendingRegistrations";
import {
    CODE_FAILURES_PER_DAY,
    CODE_FAILURES_WINDOW_MS,
    EMAIL_CODE_RESEND_SECONDS,
    EmailCodeFailures,
    createEmailCode,
    hashEmailCode
} from "../helpers/emailCodes";
import {
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    FAILED_LOGINS_PER_EMAIL,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    USERNAME_CHECKS_PER_IP,
    USERNAME_CHECKS_WINDOW_MS
} from "../middlewares/rateLimit";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    randomHex,
    registerRequest,
    setRegistrationCode,
    testEmailOf
} from "./helpers/testUsers";

const loginFrom = (clientIp: string, email: string, password: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", clientIp)
        .send({ email, password });

const expectLimitedFor = (response: supertest.Response, error: string, windowMs: number): void => {
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error, retryAfter: expect.any(Number) });

    const retryAfter: number = response.body.retryAfter;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(windowMs / 1000);
    expect(retryAfter).toBe(Number(response.headers["retry-after"]));
};

const expectRateLimited = (response: supertest.Response): void =>
    expectLimitedFor(response, Responses.tooManyFailedAttempts, FAILED_ATTEMPTS_WINDOW_MS);

const expectTooManyCodeFailures = (response: supertest.Response, since: Date): void => {
    expectLimitedFor(response, Responses.tooManyFailedAttempts, CODE_FAILURES_WINDOW_MS);
    expect(response.body.retryAfter).toBeGreaterThanOrEqual(
        Math.floor((since.getTime() + CODE_FAILURES_WINDOW_MS - Date.now()) / 1000)
    );
};

const otherCode = (code: string): string => (code === "000000" ? "000001" : "000000");

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);

const cooldownPassed = (): Date => new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000);

const failuresOf = (count: number, since: Date): EmailCodeFailures => ({ count, since });

describe("Rate Limit Tests", (): void => {
    let lockedUser: TestUser;
    let loggingInUser: TestUser;
    let guessedUser: TestUser;
    let subnetUser: TestUser;
    let changingUser: TestUser;
    let checkingUser: TestUser;
    let confirmingUser: TestUser;
    let uncheckedUser: TestUser;
    let cappedUser: TestUser;
    let restartedUser: TestUser;

    beforeAll(async (): Promise<void> => {
        [
            lockedUser,
            loggingInUser,
            guessedUser,
            subnetUser,
            changingUser,
            checkingUser,
            confirmingUser,
            uncheckedUser,
            cappedUser,
            restartedUser
        ] = await Promise.all(
            Array.from({ length: 10 }, (): Promise<TestUser> => createTestUser("rl"))
        );

        await UserModel.updateOne(
            { _id: changingUser.id },
            { $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin: "rl" } }
        );
        await linkGithub(checkingUser, true);
    }, 25000);

    describe("POST /auth/login", (): void => {
        it("should answer 429 after too many wrong passwords for one account from one IP", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIp, lockedUser.email, "wrong-password").expect(403);
            }

            expectRateLimited(await loginFrom(clientIp, lockedUser.email.toUpperCase(), "wrong"));
            expectRateLimited(await loginFrom(clientIp, lockedUser.email, lockedUser.password));
            await loginFrom(isolatedClientIp(), lockedUser.email, lockedUser.password).expect(200);
        }, 25000);

        it("should not count successful logins", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIp, loggingInUser.email, loggingInUser.password).expect(200);
                await loginFrom(clientIp, loggingInUser.email, "wrong-password").expect(403);
            }

            expectRateLimited(await loginFrom(clientIp, loggingInUser.email, "wrong-password"));
            await loginFrom(isolatedClientIp(), loggingInUser.email, loggingInUser.password).expect(
                200
            );
        }, 25000);

        it("should count an IPv6 client's whole /48 as one IP for one account", async (): Promise<void> => {
            const subnet: string = `2001:db8:${randomHex(2)}`;
            const clientIpIn = (attempt: number): string =>
                `${subnet}:${attempt.toString(16)}00::1`;

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIpIn(attempt), subnetUser.email, "wrong-password").expect(
                    403
                );
            }

            expectRateLimited(
                await loginFrom(clientIpIn(0xff), subnetUser.email, subnetUser.password)
            );
            await loginFrom(isolatedClientIp(), subnetUser.email, subnetUser.password).expect(200);
        }, 25000);

        it(`should answer 429 after ${FAILED_LOGINS_PER_EMAIL} wrong passwords for one account from any IPs`, async (): Promise<void> => {
            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: FAILED_LOGINS_PER_EMAIL }, (): supertest.Test =>
                    loginFrom(isolatedClientIp(), guessedUser.email, "wrong-password")
                )
            );

            expect(responses.map((response: supertest.Response) => response.status)).toEqual(
                Array(FAILED_LOGINS_PER_EMAIL).fill(403)
            );
            expectRateLimited(
                await loginFrom(isolatedClientIp(), guessedUser.email, guessedUser.password)
            );
        }, 25000);

        it("should answer 429 after too many failures from one IP, whatever it puts in front", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();
            const spoofedFrom = (): string => `${isolatedClientIp()}, ${clientIp}`;

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: FAILED_ATTEMPTS_PER_IP }, (): supertest.Test =>
                    loginFrom(spoofedFrom(), testEmailOf(`rl${randomHex(5)}`), "password")
                )
            );

            expect(responses.map((response: supertest.Response) => response.status)).toEqual(
                Array(FAILED_ATTEMPTS_PER_IP).fill(404)
            );
            expectRateLimited(
                await loginFrom(spoofedFrom(), testEmailOf(`rl${randomHex(5)}`), "password")
            );
        }, 25000);

        it("should answer the usual 400 for an e-mail that isn't a string", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: { toString: 1 }, password: "password" })
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({
                error: Responses.Authentication.missingEmailPassword
            });
        });

        it("should expose Retry-After to an allowed CORS origin", async (): Promise<void> => {
            const origin: string = process.env.CORS_ORIGIN_URLS.split(",")[0];
            const response: supertest.Response = await loginFrom(
                isolatedClientIp(),
                testEmailOf(`rl${randomHex(5)}`),
                "password"
            )
                .set("Origin", origin)
                .expect(404);

            expect(response.headers["access-control-allow-origin"]).toBe(origin);
            expect(response.headers["access-control-allow-credentials"]).toBe("true");
            expect(response.headers["access-control-expose-headers"]).toContain("Retry-After");
        });
    });

    describe("PATCH /user/password, PATCH /user/email, DELETE /user and POST/DELETE /auth/github/link", (): void => {
        const changePassword = (user: TestUser, body: object): supertest.Test =>
            request(TestData.apiURL)
                .patch("/user/password")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const changeEmail = (user: TestUser, body: object): supertest.Test =>
            request(TestData.apiURL)
                .patch("/user/email")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const githubLink = (
            method: "post" | "delete",
            user: TestUser,
            body: object
        ): supertest.Test =>
            request(TestData.apiURL)
                [method]("/auth/github/link")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const wrongPassword = { currentPassword: "wrong-password", newPassword: randomHex(12) };

        it("should answer 429 after too many wrong passwords across the endpoints, on all five", async (): Promise<void> => {
            const wrongPasswordRequests: (() => supertest.Test)[] = [
                (): supertest.Test => changePassword(changingUser, wrongPassword),
                (): supertest.Test =>
                    githubLink("post", changingUser, { password: "wrong-password" }),
                (): supertest.Test =>
                    githubLink("delete", changingUser, { password: "wrong-password" })
            ];

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await wrongPasswordRequests[attempt % wrongPasswordRequests.length]().expect(403);
            }

            expectRateLimited(await changePassword(changingUser, wrongPassword));
            expectRateLimited(
                await changeEmail(changingUser, {
                    email: testEmailOf(`rl${randomHex(5)}`),
                    password: "wrong"
                })
            );
            expectRateLimited(
                await request(TestData.apiURL)
                    .delete("/user")
                    .set("Cookie", changingUser.cookie)
                    .set("X-Forwarded-For", isolatedClientIp())
                    .send({ password: changingUser.password })
            );
            expectRateLimited(
                await githubLink("post", changingUser, { password: changingUser.password })
            );
            expectRateLimited(
                await githubLink("delete", changingUser, { password: changingUser.password })
            );
        }, 25000);

        it("should not count 400s and 409s", async (): Promise<void> => {
            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await changePassword(checkingUser, {
                    currentPassword: checkingUser.password,
                    newPassword: "short"
                }).expect(400);
                await changePassword(checkingUser, wrongPassword).expect(409);
                await changeEmail(checkingUser, {
                    email: testEmailOf(`rl${randomHex(5)}`),
                    password: checkingUser.password
                }).expect(409);
            }

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await request(TestData.apiURL)
                    .delete("/user")
                    .set("Cookie", checkingUser.cookie)
                    .set("X-Forwarded-For", isolatedClientIp())
                    .send({ username: `${checkingUser.username}x` })
                    .expect(403);
            }

            expectRateLimited(await changePassword(checkingUser, wrongPassword));
        }, 25000);
    });

    describe("POST /auth/register and POST /auth/register/resend", (): void => {
        let registeredUsers: TestUser[];

        beforeAll(async (): Promise<void> => {
            registeredUsers = await Promise.all(
                Array.from({ length: MAIL_SENDS_PER_IP }, (): Promise<TestUser> =>
                    createTestUser("rlreg")
                )
            );
        }, 25000);

        const registration = (
            email: string = testEmailOf(`rl${randomHex(5)}`)
        ): Record<string, string> => ({
            email,
            username: `rl${randomHex(5)}`,
            password: randomHex(12)
        });

        it(`should answer 429 after ${MAIL_SENDS_PER_IP} codes sent to one IP`, async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < MAIL_SENDS_PER_IP; attempt++) {
                await registerRequest({ username: "a" }, clientIp).expect(400);
                await registerRequest(registration(), clientIp).expect(202);
            }

            expectLimitedFor(
                await registerRequest(registration(), clientIp),
                Responses.tooManyEmails,
                MAIL_SENDS_WINDOW_MS
            );

            expectLimitedFor(
                await request(TestData.apiURL)
                    .post("/auth/register/resend")
                    .set("X-Forwarded-For", clientIp)
                    .send({ email: testEmailOf(`rl${randomHex(5)}`) }),
                Responses.tooManyEmails,
                MAIL_SENDS_WINDOW_MS
            );
        }, 25000);

        it(`should also answer 429 after ${MAIL_SENDS_PER_IP} registrations of existing e-mails from one IP`, async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (const registeredUser of registeredUsers) {
                await registerRequest(registration(registeredUser.email), clientIp).expect(202);
            }

            expectLimitedFor(
                await registerRequest(registration(registeredUsers[0].email), clientIp),
                Responses.tooManyEmails,
                MAIL_SENDS_WINDOW_MS
            );
        }, 25000);
    });

    describe("GET /auth/username-available", (): void => {
        const usernameCheckFrom = (clientIp: string): supertest.Test =>
            request(TestData.apiURL)
                .get("/auth/username-available")
                .set("X-Forwarded-For", clientIp)
                .query({ username: `rl${randomHex(5)}` });

        it(`should answer 429 after ${USERNAME_CHECKS_PER_IP} checks from one IP`, async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: USERNAME_CHECKS_PER_IP }, (): supertest.Test =>
                    usernameCheckFrom(clientIp)
                )
            );

            expect(responses.map((response: supertest.Response) => response.status)).toEqual(
                Array(USERNAME_CHECKS_PER_IP).fill(200)
            );

            expectLimitedFor(
                await usernameCheckFrom(clientIp),
                Responses.tooManyUsernameChecks,
                USERNAME_CHECKS_WINDOW_MS
            );

            await usernameCheckFrom(isolatedClientIp()).expect(200);
        }, 25000);
    });

    describe("POST /auth/register/verify", (): void => {
        const verifyFrom = (clientIp: string, email: string, code: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/register/verify")
                .set("X-Forwarded-For", clientIp)
                .send({ email, code, username: `rl${randomHex(5)}`, password: randomHex(12) });

        it("should answer 429 after too many wrong codes for one e-mail", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            await registerRequest({
                email,
                username: `rl${randomHex(5)}`,
                password: randomHex(12)
            });
            const code: string = await setRegistrationCode(email);
            const wrongCode: string = code === "000000" ? "000001" : "000000";

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await verifyFrom(isolatedClientIp(), email, wrongCode).expect(400);
            }

            expectRateLimited(await verifyFrom(isolatedClientIp(), email.toUpperCase(), code));
        }, 25000);
    });

    describe("POST /auth/password-reset/confirm and POST /user/email/confirm", (): void => {
        const confirmResetWith = (body: Record<string, unknown>): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/password-reset/confirm")
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const confirmReset = (email: string): supertest.Test =>
            confirmResetWith({ email, code: "123456", newPassword: randomHex(12) });

        const confirmEmailWith = (user: TestUser, body: Record<string, unknown>): supertest.Test =>
            request(TestData.apiURL)
                .post("/user/email/confirm")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        it("should not count requests that don't get to check a code", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const unchecked: Record<string, unknown>[] = [
                { email, newPassword: randomHex(12) },
                { email, code: 123456, newPassword: randomHex(12) },
                { email, code: "123456" },
                { email, code: "123456", newPassword: "short" }
            ];

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                for (const body of unchecked) {
                    await confirmResetWith(body).expect(400);
                }
                for (const body of [
                    { email },
                    { email, code: "123456", username: `rl${randomHex(5)}`, password: "short" }
                ]) {
                    await request(TestData.apiURL)
                        .post("/auth/register/verify")
                        .set("X-Forwarded-For", isolatedClientIp())
                        .send(body)
                        .expect(400);
                }
                await confirmEmailWith(uncheckedUser, {}).expect(400);
            }

            await confirmReset(email).expect(400);
            await confirmEmailWith(uncheckedUser, { code: "123456" }).expect(400);
        }, 25000);
    });

    describe(`${CODE_FAILURES_PER_DAY} wrong codes a day`, (): void => {
        const fromIsolatedIp = (test: supertest.Test): supertest.Test =>
            test.set("X-Forwarded-For", isolatedClientIp());

        const storedReset = async (user: TestUser) =>
            (await UserModel.findById(user.id).select("+authentication.passwordReset").lean())
                .authentication?.passwordReset;

        const setResetCode = async (
            user: TestUser,
            failures?: EmailCodeFailures
        ): Promise<string> => {
            const code: string = createEmailCode();

            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.passwordReset.hash": hashEmailCode(
                            passwordResetScope(user.id, user.email),
                            code
                        ),
                        "authentication.passwordReset.sentAt": cooldownPassed(),
                        "authentication.passwordReset.expiresAt": new Date(
                            Date.now() + 60 * 60 * 1000
                        ),
                        "authentication.passwordReset.attempts": 0,
                        ...(failures && { "authentication.passwordReset.failures": failures })
                    }
                }
            );

            return code;
        };

        const confirmReset = (user: TestUser, code: string): supertest.Test =>
            fromIsolatedIp(request(TestData.apiURL).post("/auth/password-reset/confirm")).send({
                email: user.email,
                code,
                newPassword: randomHex(12)
            });

        it("should answer 429 to the right reset code once the count is full, kept across resends", async (): Promise<void> => {
            const since: Date = hoursAgo(1);
            const code: string = await setResetCode(
                cappedUser,
                failuresOf(CODE_FAILURES_PER_DAY - 1, since)
            );

            await confirmReset(cappedUser, otherCode(code)).expect(400);
            expect((await storedReset(cappedUser)).failures).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            await fromIsolatedIp(request(TestData.apiURL).post("/auth/password-reset"))
                .send({ email: cappedUser.email })
                .expect(200);
            const resent = await storedReset(cappedUser);
            expect(resent.hash).not.toBe(
                hashEmailCode(passwordResetScope(cappedUser.id, cappedUser.email), code)
            );
            expect(resent).toMatchObject({
                attempts: 0,
                failures: failuresOf(CODE_FAILURES_PER_DAY, since)
            });

            const newCode: string = await setResetCode(cappedUser);
            expectTooManyCodeFailures(await confirmReset(cappedUser, newCode), since);
            expectTooManyCodeFailures(await confirmReset(cappedUser, otherCode(newCode)), since);
            expect((await storedReset(cappedUser)).failures).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );
        }, 25000);

        it("should start the count over once its day is up", async (): Promise<void> => {
            const code: string = await setResetCode(
                restartedUser,
                failuresOf(CODE_FAILURES_PER_DAY, hoursAgo(25))
            );

            await confirmReset(restartedUser, otherCode(code)).expect(400);
            const { failures } = await storedReset(restartedUser);
            expect(failures.count).toBe(1);
            expect(Date.now() - failures.since.getTime()).toBeLessThan(60 * 1000);

            await confirmReset(restartedUser, code).expect(200);
        }, 25000);

        it("should keep the count for one account across e-mail changes to other addresses", async (): Promise<void> => {
            const storedChange = async () =>
                (
                    await UserModel.findById(confirmingUser.id)
                        .select("+authentication.emailChange")
                        .lean()
                ).authentication?.emailChange;

            const changeEmail = (email: string): supertest.Test =>
                fromIsolatedIp(request(TestData.apiURL).patch("/user/email"))
                    .set("Cookie", confirmingUser.cookie)
                    .send({ email, password: confirmingUser.password });

            const setChangeCode = async (email: string): Promise<string> => {
                const code: string = createEmailCode();

                await UserModel.updateOne(
                    { _id: confirmingUser.id },
                    {
                        $set: {
                            "authentication.emailChange.hash": hashEmailCode(
                                emailChangeScope(confirmingUser.id, email),
                                code
                            ),
                            "authentication.emailChange.sentAt": cooldownPassed()
                        }
                    }
                );

                return code;
            };

            const confirmEmail = (code: string): supertest.Test =>
                fromIsolatedIp(request(TestData.apiURL).post("/user/email/confirm"))
                    .set("Cookie", confirmingUser.cookie)
                    .send({ code });

            const firstEmail: string = testEmailOf(`rl${randomHex(5)}`);
            const secondEmail: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(2);

            await changeEmail(firstEmail).expect(202);
            const code: string = await setChangeCode(firstEmail);
            await UserModel.updateOne(
                { _id: confirmingUser.id },
                {
                    $set: {
                        "authentication.emailChange.failures": failuresOf(
                            CODE_FAILURES_PER_DAY - 1,
                            since
                        )
                    }
                }
            );

            await confirmEmail(otherCode(code)).expect(400);

            await changeEmail(secondEmail).expect(202);
            expect(await storedChange()).toMatchObject({
                email: secondEmail,
                attempts: 0,
                failures: failuresOf(CODE_FAILURES_PER_DAY, since)
            });

            expectTooManyCodeFailures(await confirmEmail(await setChangeCode(secondEmail)), since);
            expect(
                await request(TestData.apiURL).get("/user").set("Cookie", confirmingUser.cookie)
            ).toHaveProperty("body.email", confirmingUser.email);
        }, 25000);

        it("should keep the count for a registration across re-registrations and resends", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(3);
            const registration = (): Record<string, unknown> => ({
                email,
                username: `rl${randomHex(5)}`,
                password: randomHex(12)
            });
            const storedFailures = async (): Promise<EmailCodeFailures> =>
                (await PendingRegistrationModel.findOne({ email }).lean()).code
                    .failures as EmailCodeFailures;
            const passCooldown = () =>
                PendingRegistrationModel.updateOne(
                    { email },
                    { $set: { "code.sentAt": cooldownPassed() } }
                );
            const verify = (code: string): supertest.Test =>
                fromIsolatedIp(request(TestData.apiURL).post("/auth/register/verify")).send({
                    ...registration(),
                    code
                });

            await registerRequest(registration()).expect(202);
            const code: string = await setRegistrationCode(email);
            await PendingRegistrationModel.updateOne(
                { email },
                { $set: { "code.failures": failuresOf(CODE_FAILURES_PER_DAY - 1, since) } }
            );

            await verify(otherCode(code)).expect(400);
            expect(await storedFailures()).toEqual(failuresOf(CODE_FAILURES_PER_DAY, since));

            await passCooldown();
            await registerRequest(registration()).expect(202);
            expect(await storedFailures()).toEqual(failuresOf(CODE_FAILURES_PER_DAY, since));

            await passCooldown();
            await fromIsolatedIp(request(TestData.apiURL).post("/auth/register/resend"))
                .send({ email })
                .expect(200);
            expect(await storedFailures()).toEqual(failuresOf(CODE_FAILURES_PER_DAY, since));

            expectTooManyCodeFailures(await verify(await setRegistrationCode(email)), since);
        }, 25000);
    });
});
