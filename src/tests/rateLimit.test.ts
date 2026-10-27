import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS
} from "../middlewares/rateLimit";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";

const isolatedClientIp = (): string => `2001:db8:${randomHex(2)}::1`;

const loginFrom = (clientIp: string, email: string, password: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", clientIp)
        .send({ email, password });

const expectRateLimited = (response: supertest.Response): void => {
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: Responses.tooManyFailedAttempts });

    const retryAfter: number = Number(response.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(FAILED_ATTEMPTS_WINDOW_MS / 1000);
};

describe("Rate Limit Tests", (): void => {
    let lockedUser: TestUser;
    let loggingInUser: TestUser;
    let changingUser: TestUser;

    beforeAll(async (): Promise<void> => {
        [lockedUser, loggingInUser, changingUser] = await Promise.all([
            createTestUser("rl"),
            createTestUser("rl"),
            createTestUser("rl")
        ]);
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
        });

        it("should not count successful logins", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIp, loggingInUser.email, loggingInUser.password).expect(200);
                await loginFrom(clientIp, loggingInUser.email, "wrong-password").expect(403);
            }

            expectRateLimited(await loginFrom(clientIp, loggingInUser.email, "wrong-password"));
        });

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
        });
    });

    describe("PATCH /user/password", (): void => {
        it("should answer 429 after too many wrong passwords, also on PATCH /user/email", async (): Promise<void> => {
            const changePassword = (currentPassword: string): supertest.Test =>
                request(TestData.apiURL)
                    .patch("/user/password")
                    .set("Cookie", changingUser.cookie)
                    .set("X-Forwarded-For", isolatedClientIp())
                    .send({ currentPassword, newPassword: randomHex(12) });

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await changePassword("wrong-password").expect(403);
            }

            expectRateLimited(await changePassword("wrong-password"));
            expectRateLimited(
                await request(TestData.apiURL)
                    .patch("/user/email")
                    .set("Cookie", changingUser.cookie)
                    .set("X-Forwarded-For", isolatedClientIp())
                    .send({ email: testEmailOf(`rl${randomHex(5)}`), password: "wrong" })
            );
        });
    });
});
