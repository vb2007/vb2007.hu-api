import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import {
    CODE_FAILURES_PER_DAY,
    CODE_FAILURES_WINDOW_MS,
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

const LOGINS_AT_ONCE: number = 6;

const loginStatusesInBatches = async (
    count: number,
    sendLogin: () => supertest.Test
): Promise<number[]> => {
    const statuses: number[] = [];

    while (statuses.length < count) {
        const batch: supertest.Response[] = await Promise.all(
            Array.from({ length: Math.min(LOGINS_AT_ONCE, count - statuses.length) }, sendLogin)
        );
        statuses.push(...batch.map((response: supertest.Response) => response.status));
    }

    return statuses;
};

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

const dailyCodePolicy: string = `"${CODE_FAILURES_PER_DAY}-in-1day"`;

const dailyCodeGuessesLeft = (response: supertest.Response): number => {
    expect(response.headers["ratelimit-policy"]).toContain(
        `${dailyCodePolicy}; q=${CODE_FAILURES_PER_DAY}; w=${CODE_FAILURES_WINDOW_MS / 1000};`
    );

    return Number(response.headers["ratelimit"].match(`${dailyCodePolicy}; r=(\\d+);`)[1]);
};

describe("Rate Limit Tests", (): void => {
    let lockedUser: TestUser;
    let loggingInUser: TestUser;
    let guessedUser: TestUser;
    let subnetUser: TestUser;
    let changingUser: TestUser;
    let checkingUser: TestUser;
    let confirmingUser: TestUser;
    let uncheckedUser: TestUser;

    beforeAll(async (): Promise<void> => {
        [
            lockedUser,
            loggingInUser,
            guessedUser,
            subnetUser,
            changingUser,
            checkingUser,
            confirmingUser,
            uncheckedUser
        ] = await Promise.all(
            Array.from({ length: 8 }, (): Promise<TestUser> => createTestUser("rl"))
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
            const statuses: number[] = await loginStatusesInBatches(
                FAILED_LOGINS_PER_EMAIL,
                (): supertest.Test =>
                    loginFrom(isolatedClientIp(), guessedUser.email, "wrong-password")
            );

            expect(statuses).toEqual(Array(FAILED_LOGINS_PER_EMAIL).fill(403));
            expectRateLimited(
                await loginFrom(isolatedClientIp(), guessedUser.email, guessedUser.password)
            );
        }, 25000);

        it("should answer 429 after too many failures from one IP, whatever it puts in front", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();
            const spoofedFrom = (): string => `${isolatedClientIp()}, ${clientIp}`;

            const statuses: number[] = await loginStatusesInBatches(
                FAILED_ATTEMPTS_PER_IP,
                (): supertest.Test =>
                    loginFrom(spoofedFrom(), testEmailOf(`rl${randomHex(5)}`), "password")
            );

            expect(statuses).toEqual(Array(FAILED_ATTEMPTS_PER_IP).fill(403));
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
                .expect(403);

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

        it(`should also count wrong codes for one e-mail against ${CODE_FAILURES_PER_DAY} a day`, async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                const response: supertest.Response = await confirmReset(
                    attempt % 2 ? email.toUpperCase() : email
                ).expect(400);

                expect(dailyCodeGuessesLeft(response)).toBe(CODE_FAILURES_PER_DAY - attempt - 1);
            }

            expectRateLimited(await confirmReset(email));

            const otherResponse: supertest.Response = await confirmReset(
                testEmailOf(`rl${randomHex(5)}`)
            ).expect(400);
            expect(dailyCodeGuessesLeft(otherResponse)).toBe(CODE_FAILURES_PER_DAY - 1);
        }, 25000);

        it(`should also count wrong codes for one account against ${CODE_FAILURES_PER_DAY} a day`, async (): Promise<void> => {
            const confirmEmail = (): supertest.Test =>
                confirmEmailWith(confirmingUser, { code: "123456" });

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                const response: supertest.Response = await confirmEmail().expect(400);

                expect(dailyCodeGuessesLeft(response)).toBe(CODE_FAILURES_PER_DAY - attempt - 1);
            }

            expectRateLimited(await confirmEmail());
        }, 25000);

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

            expect(dailyCodeGuessesLeft(await confirmReset(email).expect(400))).toBe(
                CODE_FAILURES_PER_DAY - 1
            );
            expect(
                dailyCodeGuessesLeft(
                    await confirmEmailWith(uncheckedUser, { code: "123456" }).expect(400)
                )
            ).toBe(CODE_FAILURES_PER_DAY - 1);
        }, 25000);
    });
});
