import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel, passwordResetScope } from "../database/users";
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
import { DEVICE_COOKIE_MAX_AGE_MS, deviceCookie, deviceCookieValue } from "../helpers/deviceCookie";
import { hashEmailCode } from "../helpers/emailCodes";
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

const setDeviceCookieOf = (response: supertest.Response): string =>
    response
        .get("Set-Cookie")
        .find((cookie: string): boolean => cookie.startsWith(`${deviceCookie}=`));

const failLoginsFromAnyIp = async (email: string, cookie: string = ""): Promise<void> => {
    const responses: supertest.Response[] = await Promise.all(
        Array.from({ length: FAILED_LOGINS_PER_EMAIL }, (): supertest.Test =>
            loginFrom(isolatedClientIp(), email, "wrong-password").set("Cookie", cookie)
        )
    );

    expect(responses.map((response: supertest.Response) => response.status)).toEqual(
        Array(FAILED_LOGINS_PER_EMAIL).fill(403)
    );
};

const rememberedLogin = async (user: TestUser): Promise<string> =>
    setDeviceCookieOf(
        await loginFrom(isolatedClientIp(), user.email, user.password).expect(200)
    ).split(";")[0];

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
    let rememberedUser: TestUser;
    let rememberedLockedUser: TestUser;
    let passwordChangedUser: TestUser;
    let passwordResetUser: TestUser;

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
            rememberedUser,
            rememberedLockedUser,
            passwordChangedUser,
            passwordResetUser
        ] = await Promise.all(
            Array.from({ length: 12 }, (): Promise<TestUser> => createTestUser("rl"))
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

        it("should set a device cookie for the login route on a successful login", async (): Promise<void> => {
            const response: supertest.Response = await loginFrom(
                isolatedClientIp(),
                rememberedLockedUser.email,
                rememberedLockedUser.password
            ).expect(200);
            const cookie: string = setDeviceCookieOf(response);

            expect(response.headers["set-cookie"][0]).toMatch(/^VB-AUTH=/);
            expect(cookie).toMatch(/; Path=\/auth\/login;/);
            expect(cookie).toMatch(/; HttpOnly/);
            expect(cookie).toContain(`Max-Age=${DEVICE_COOKIE_MAX_AGE_MS / 1000};`);
        });

        it(`should let a device cookie from an earlier login past the ${FAILED_LOGINS_PER_EMAIL} per e-mail, and nothing else`, async (): Promise<void> => {
            const [cookie, otherCookie]: string[] = await Promise.all(
                [rememberedUser, rememberedLockedUser].map(rememberedLogin)
            );
            const [issuedAt, signature]: string[] = cookie.split("=")[1].split(".");
            const storedUser = await UserModel.findById(rememberedUser.id).select(
                "+authentication.salt"
            );
            const signedAt = (time: number): string =>
                `${deviceCookie}=${deviceCookieValue(storedUser, time)}`;
            const loginWith = (deviceCookieHeader: string): supertest.Test =>
                loginFrom(isolatedClientIp(), rememberedUser.email, rememberedUser.password).set(
                    "Cookie",
                    deviceCookieHeader
                );

            await failLoginsFromAnyIp(rememberedUser.email);

            const refusedCookies: string[] = [
                "",
                `${deviceCookie}=${Date.now()}.${randomHex(32)}`,
                `${deviceCookie}=${Number(issuedAt) + 1}.${signature}`,
                `${deviceCookie}=${issuedAt}.${signature.slice(0, -1)}`,
                `${deviceCookie}=${issuedAt}`,
                otherCookie,
                signedAt(Date.now() - DEVICE_COOKIE_MAX_AGE_MS - 60000),
                signedAt(Date.now() + 60000)
            ];
            for (const refusedCookie of refusedCookies) {
                expectRateLimited(await loginWith(refusedCookie));
            }

            await loginWith(cookie).expect(200);
            await loginWith(signedAt(Date.now() - 60000)).expect(200);
            await loginFrom(isolatedClientIp(), rememberedUser.email.toUpperCase(), "wrong")
                .set("Cookie", cookie)
                .expect(403);
        }, 25000);

        it("should stop letting a device cookie past once the password is changed or reset", async (): Promise<void> => {
            const changedLogin: supertest.Response = await loginFrom(
                isolatedClientIp(),
                passwordChangedUser.email,
                passwordChangedUser.password
            ).expect(200);
            const changedCookie: string = setDeviceCookieOf(changedLogin).split(";")[0];
            const resetCookie: string = await rememberedLogin(passwordResetUser);
            const newPassword: string = randomHex(12);

            await request(TestData.apiURL)
                .patch("/user/password")
                .set("Cookie", changedLogin.headers["set-cookie"][0])
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ currentPassword: passwordChangedUser.password, newPassword })
                .expect(200);

            await request(TestData.apiURL)
                .post("/auth/password-reset")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: passwordResetUser.email })
                .expect(200);
            const code: string = "123456";
            await UserModel.updateOne(
                { _id: passwordResetUser.id },
                {
                    $set: {
                        "authentication.passwordReset.hash": hashEmailCode(
                            passwordResetScope(passwordResetUser.id, passwordResetUser.email),
                            code
                        )
                    }
                }
            );
            await request(TestData.apiURL)
                .post("/auth/password-reset/confirm")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: passwordResetUser.email, code, newPassword })
                .expect(200);

            await Promise.all(
                [passwordChangedUser, passwordResetUser].map((user: TestUser): Promise<void> =>
                    failLoginsFromAnyIp(user.email)
                )
            );

            expectRateLimited(
                await loginFrom(isolatedClientIp(), passwordChangedUser.email, newPassword).set(
                    "Cookie",
                    changedCookie
                )
            );
            expectRateLimited(
                await loginFrom(isolatedClientIp(), passwordResetUser.email, newPassword).set(
                    "Cookie",
                    resetCookie
                )
            );
        }, 25000);

        it("should still answer 429 after too many wrong passwords from one IP with a device cookie", async (): Promise<void> => {
            const cookie: string = await rememberedLogin(rememberedLockedUser);
            const clientIp: string = isolatedClientIp();
            const loginWithCookie = (password: string): supertest.Test =>
                loginFrom(clientIp, rememberedLockedUser.email, password).set("Cookie", cookie);

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginWithCookie("wrong-password").expect(403);
            }

            expectRateLimited(await loginWithCookie(rememberedLockedUser.password));
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
