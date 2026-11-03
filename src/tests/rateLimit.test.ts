import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import {
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    USERNAME_CHECKS_PER_IP,
    USERNAME_CHECKS_WINDOW_MS
} from "../middlewares/rateLimit";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
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

describe("Rate Limit Tests", (): void => {
    let lockedUser: TestUser;
    let loggingInUser: TestUser;
    let changingUser: TestUser;
    let checkingUser: TestUser;

    beforeAll(async (): Promise<void> => {
        [lockedUser, loggingInUser, changingUser, checkingUser] = await Promise.all([
            createTestUser("rl"),
            createTestUser("rl"),
            createTestUser("rl"),
            createTestUser("rl")
        ]);

        await UserModel.updateOne(
            { _id: changingUser.id },
            { $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin: "rl" } }
        );
    }, 25000);

    describe("POST /auth/login", (): void => {
        it("should answer 429 after too many wrong passwords for one account", async (): Promise<void> => {
            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(isolatedClientIp(), lockedUser.email, "wrong-password").expect(403);
            }

            expectRateLimited(
                await loginFrom(isolatedClientIp(), lockedUser.email.toUpperCase(), "wrong")
            );
            expectRateLimited(
                await loginFrom(isolatedClientIp(), lockedUser.email, lockedUser.password)
            );
        }, 25000);

        it("should not count successful logins", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIp, loggingInUser.email, loggingInUser.password).expect(200);
                await loginFrom(clientIp, loggingInUser.email, "wrong-password").expect(403);
            }

            expectRateLimited(await loginFrom(clientIp, loggingInUser.email, "wrong-password"));
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
                await changeEmail(checkingUser, {
                    email: lockedUser.email,
                    password: checkingUser.password
                }).expect(409);
            }

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await changePassword(checkingUser, wrongPassword).expect(403);
            }

            expectRateLimited(await changePassword(checkingUser, wrongPassword));
        }, 25000);
    });

    describe("POST /auth/register and POST /auth/register/resend", (): void => {
        const registration = (): Record<string, string> => ({
            email: testEmailOf(`rl${randomHex(5)}`),
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

            await request(TestData.apiURL)
                .post("/auth/register/resend")
                .set("X-Forwarded-For", clientIp)
                .send({ email: testEmailOf(`rl${randomHex(5)}`) })
                .expect(429);
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

            const response: supertest.Response = await usernameCheckFrom(clientIp);
            expect(response.status).toBe(429);
            expect(response.body).toEqual({ error: Responses.tooManyUsernameChecks });

            const retryAfter: number = Number(response.headers["retry-after"]);
            expect(retryAfter).toBeGreaterThan(0);
            expect(retryAfter).toBeLessThanOrEqual(USERNAME_CHECKS_WINDOW_MS / 1000);

            await usernameCheckFrom(isolatedClientIp()).expect(200);
        }, 25000);
    });

    describe("POST /auth/register/verify", (): void => {
        const verifyFrom = (clientIp: string, email: string, code: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/register/verify")
                .set("X-Forwarded-For", clientIp)
                .send({ email, code });

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
});
