import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel, emailChangeScope, passwordResetScope } from "../database/users";
import { PendingRegistrationModel } from "../database/pendingRegistrations";
import { EmailCodeFailures, createEmailCode, hashEmailCode } from "../helpers/emailCodes";
import {
    CODE_FAILURES_PER_DAY,
    CODE_FAILURES_WINDOW_MS,
    DEVICE_COOKIE_MAX_AGE_MS,
    EMAIL_CODE_MAX_ATTEMPTS,
    EMAIL_CODE_RESEND_SECONDS,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    FAILED_LOGINS_PER_EMAIL,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    USERNAME_CHECKS_PER_IP,
    USERNAME_CHECKS_WINDOW_MS
} from "../constants/limits";
import { deviceCookie, deviceCookieValue } from "../helpers/deviceCookie";
import { sessionCookie } from "../helpers/session";
import { parseCorsOrigins } from "../helpers/cors";
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
import { runRequestReset } from "./helpers/passwordReset";
import { runResendRegistration } from "./helpers/emailHandlers";
import { itWithGithub } from "./helpers/githubTests";
import { sendRawRequests } from "./helpers/overLimitBody";

const loginFrom = (clientIp: string, email: string, password: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", clientIp)
        .send({ email, password });

const loginThenMalformedRequest = (clientIp: string, email: string, password: string): Buffer => {
    const body: string = JSON.stringify({ email, password });

    return Buffer.from(
        `POST /auth/login HTTP/1.1\r\nHost: ${process.env.APP_IP}\r\nX-Forwarded-For: ${clientIp}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}0\r\n\r\n`
    );
};

const closedConnectionCountedMs: number = 5000;

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

const setDeviceCookieOf = (response: supertest.Response): string =>
    response
        .get("Set-Cookie")
        .find((cookie: string): boolean => cookie.startsWith(`${deviceCookie}=`));

const failLoginsFromAnyIp = async (email: string, cookie: string = ""): Promise<void> => {
    const statuses: number[] = await loginStatusesInBatches(
        FAILED_LOGINS_PER_EMAIL,
        (): supertest.Test =>
            loginFrom(isolatedClientIp(), email, "wrong-password").set("Cookie", cookie)
    );

    expect(statuses).toEqual(Array(FAILED_LOGINS_PER_EMAIL).fill(403));
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

const failedAttemptsPolicy = (limit: number): string =>
    `"${limit}-in-${FAILED_ATTEMPTS_WINDOW_MS / 60000}min"`;

const rateLimitEntries = (response: supertest.Response, header: string): string[] =>
    (response.headers[header] ?? "").split(", ");

const expectPolicies = (response: supertest.Response, limits: number[]): void =>
    expect(
        rateLimitEntries(response, "ratelimit-policy").map(
            (entry: string): string => entry.split("; ")[0]
        )
    ).toEqual(limits.map(failedAttemptsPolicy));

const expectFirstFailureCounts = (response: supertest.Response, limits: number[]): void => {
    expectPolicies(response, limits);

    const [ipRemaining, ...ownRemaining]: number[] = rateLimitEntries(response, "ratelimit").map(
        (entry: string): number => Number(entry.match(/; r=(\d+);/)[1])
    );
    expect(ipRemaining).toBeLessThan(FAILED_ATTEMPTS_PER_IP);
    expect(ownRemaining).toEqual(limits.slice(1).map((limit: number): number => limit - 1));
};

const expectOwnCodeFailuresOnly = async (
    checkWrongCode: (email: string) => supertest.Test
): Promise<void> => {
    const triedEmail: string = testEmailOf(`rl${randomHex(5)}`);
    await checkWrongCode(triedEmail).expect(400);

    for (const email of [triedEmail, testEmailOf(`rl${randomHex(5)}`)]) {
        const response: supertest.Response = await checkWrongCode(email).expect(400);
        expectFirstFailureCounts(response, [FAILED_ATTEMPTS_PER_IP]);
    }
};

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
    let movingUser: TestUser;
    let switchingUser: TestUser;
    let rememberedUser: TestUser;
    let otherRememberedUser: TestUser;
    let passwordChangedUser: TestUser;
    let passwordResetUser: TestUser;
    let deviceGuessedUser: TestUser;
    let triedUser: TestUser;
    let codeCheckingUser: TestUser;
    let spentResetUser: TestUser;
    let cappedSpentResetUser: TestUser;
    let spentChangeUser: TestUser;
    let cappedSpentChangeUser: TestUser;
    let restartedSpentResetUser: TestUser;
    let uncodedResetUser: TestUser;
    let disconnectedUser: TestUser;

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
            restartedUser,
            movingUser,
            switchingUser,
            rememberedUser,
            otherRememberedUser,
            passwordChangedUser,
            passwordResetUser,
            deviceGuessedUser,
            triedUser,
            codeCheckingUser,
            spentResetUser,
            cappedSpentResetUser,
            spentChangeUser,
            cappedSpentChangeUser,
            restartedSpentResetUser,
            uncodedResetUser,
            disconnectedUser
        ] = await Promise.all(
            Array.from({ length: 26 }, (): Promise<TestUser> => createTestUser("rl"))
        );

        await UserModel.updateOne(
            { _id: changingUser.id },
            { $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin: "rl" } }
        );
        await linkGithub(checkingUser, true);
    });

    describe("POST /auth/login", (): void => {
        it("should answer 429 after too many wrong passwords for one account from one IP", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIp, lockedUser.email, "wrong-password").expect(403);
            }

            expectRateLimited(await loginFrom(clientIp, lockedUser.email.toUpperCase(), "wrong"));
            expectRateLimited(await loginFrom(clientIp, lockedUser.email, lockedUser.password));
            await loginFrom(isolatedClientIp(), lockedUser.email, lockedUser.password).expect(200);
        });

        it("should count wrong passwords whose connection closes before their answer", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                expect(
                    await sendRawRequests(
                        loginThenMalformedRequest(
                            clientIp,
                            disconnectedUser.email,
                            "wrong-password"
                        )
                    )
                ).toEqual([400]);
            }

            const deadline: number = Date.now() + closedConnectionCountedMs;
            let response: supertest.Response;

            do {
                response = await loginFrom(
                    clientIp,
                    disconnectedUser.email,
                    disconnectedUser.password
                );
            } while (response.status === 200 && Date.now() < deadline);

            expectRateLimited(response);
        });

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
        });

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
        });

        it(`should answer 429 after ${FAILED_LOGINS_PER_EMAIL} wrong passwords for one account from any IPs`, async (): Promise<void> => {
            const statuses: number[] = await loginStatusesInBatches(
                FAILED_LOGINS_PER_EMAIL,
                (): supertest.Test =>
                    loginFrom(isolatedClientIp(), guessedUser.email, "wrong-password")
            );

            expect(statuses).toEqual(Array(FAILED_LOGINS_PER_EMAIL).fill(403));
            const limited: supertest.Response = await loginFrom(
                isolatedClientIp(),
                guessedUser.email,
                guessedUser.password
            );
            expectRateLimited(limited);
            expectPolicies(limited, [FAILED_ATTEMPTS_PER_IP, FAILED_ATTEMPTS_PER_ACCOUNT]);
        }, 240000);

        it("should not show other clients' failed logins for an address in the RateLimit headers", async (): Promise<void> => {
            const cookie: string = await rememberedLogin(triedUser);
            await loginFrom(isolatedClientIp(), triedUser.email, "wrong-password").expect(403);

            const responses: supertest.Response[] = [
                await loginFrom(isolatedClientIp(), triedUser.email, "wrong-password"),
                await loginFrom(isolatedClientIp(), triedUser.email, "wrong-password").set(
                    "Cookie",
                    cookie
                ),
                await loginFrom(isolatedClientIp(), testEmailOf(`rl${randomHex(5)}`), "password")
            ];

            for (const response of responses) {
                expect(response.status).toBe(403);
                expectFirstFailureCounts(response, [
                    FAILED_ATTEMPTS_PER_IP,
                    FAILED_ATTEMPTS_PER_ACCOUNT
                ]);
            }
        });

        it("should set a device cookie for the login route on a successful login", async (): Promise<void> => {
            const response: supertest.Response = await loginFrom(
                isolatedClientIp(),
                otherRememberedUser.email,
                otherRememberedUser.password
            ).expect(200);
            const cookie: string = setDeviceCookieOf(response);

            expect(response.headers["set-cookie"][0]).toMatch(new RegExp(`^${sessionCookie}=`));
            expect(cookie).toMatch(/; Path=\/auth\/login;/);
            expect(cookie).toMatch(/; HttpOnly/);
            expect(cookie).not.toMatch(/; Domain=/i);
            expect(cookie).toContain(`Max-Age=${DEVICE_COOKIE_MAX_AGE_MS / 1000};`);
        });

        it(`should give a device cookie from an earlier login its own ${FAILED_LOGINS_PER_EMAIL} per e-mail, and nothing else`, async (): Promise<void> => {
            const [cookie, otherCookie]: string[] = await Promise.all(
                [rememberedUser, otherRememberedUser].map(rememberedLogin)
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
        }, 240000);

        it(`should answer 429 after ${FAILED_LOGINS_PER_EMAIL} wrong passwords with one device cookie from any IPs`, async (): Promise<void> => {
            const cookie: string = await rememberedLogin(deviceGuessedUser);
            const otherCookie: string = await rememberedLogin(deviceGuessedUser);
            const loginWith = (deviceCookieHeader: string): supertest.Test =>
                loginFrom(
                    isolatedClientIp(),
                    deviceGuessedUser.email,
                    deviceGuessedUser.password
                ).set("Cookie", deviceCookieHeader);

            expect(otherCookie).not.toBe(cookie);
            await failLoginsFromAnyIp(deviceGuessedUser.email, cookie);

            expectRateLimited(await loginWith(cookie));
            await loginWith(otherCookie).expect(200);
            await loginWith("").expect(200);
        }, 240000);

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

            await runRequestReset(passwordResetUser.email);
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
        }, 480000);

        it("should still answer 429 after too many wrong passwords from one IP with a device cookie", async (): Promise<void> => {
            const cookie: string = await rememberedLogin(otherRememberedUser);
            const clientIp: string = isolatedClientIp();
            const loginWithCookie = (password: string): supertest.Test =>
                loginFrom(clientIp, otherRememberedUser.email, password).set("Cookie", cookie);

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginWithCookie("wrong-password").expect(403);
            }

            expectRateLimited(await loginWithCookie(otherRememberedUser.password));
        });

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
        }, 240000);

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
            const origin: string = parseCorsOrigins(process.env.CORS_ORIGIN_URLS)[0];
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

        itWithGithub(
            "should answer 429 after too many wrong passwords across the endpoints, on all five",
            async (): Promise<void> => {
                const wrongPasswordRequests: (() => supertest.Test)[] = [
                    (): supertest.Test => changePassword(changingUser, wrongPassword),
                    (): supertest.Test =>
                        githubLink("post", changingUser, { password: "wrong-password" }),
                    (): supertest.Test =>
                        githubLink("delete", changingUser, { password: "wrong-password" })
                ];

                for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                    await wrongPasswordRequests[attempt % wrongPasswordRequests.length]().expect(
                        403
                    );
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
            }
        );

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
        });
    });

    describe("POST /auth/register and POST /auth/register/resend", (): void => {
        let registeredUsers: TestUser[];

        beforeAll(async (): Promise<void> => {
            registeredUsers = await Promise.all(
                Array.from({ length: MAIL_SENDS_PER_IP }, (): Promise<TestUser> =>
                    createTestUser("rlreg")
                )
            );
        });

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
        });

        it(`should count every resend, also one within the cooldown, and answer 429 after ${MAIL_SENDS_PER_IP}`, async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();
            const waiting: Record<string, string> = registration();
            await registerRequest(waiting).expect(202);
            const resendFrom = (email: string): supertest.Test =>
                request(TestData.apiURL)
                    .post("/auth/register/resend")
                    .set("X-Forwarded-For", clientIp)
                    .send({ email });

            for (let attempt = 0; attempt < MAIL_SENDS_PER_IP; attempt++) {
                await resendFrom(
                    attempt % 2 ? waiting.email : testEmailOf(`rl${randomHex(5)}`)
                ).expect(200);
            }

            expectLimitedFor(
                await resendFrom(waiting.email),
                Responses.tooManyEmails,
                MAIL_SENDS_WINDOW_MS
            );
            expectLimitedFor(
                await resendFrom(testEmailOf(`rl${randomHex(5)}`)),
                Responses.tooManyEmails,
                MAIL_SENDS_WINDOW_MS
            );
        });

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
        });
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
        });
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

            const limited: supertest.Response = await verifyFrom(
                isolatedClientIp(),
                email.toUpperCase(),
                code
            );
            expectRateLimited(limited);
            expectPolicies(limited, [FAILED_ATTEMPTS_PER_IP]);
        });

        it("should not show other clients' wrong codes for an address in the RateLimit headers", async (): Promise<void> => {
            await expectOwnCodeFailuresOnly((email: string): supertest.Test =>
                verifyFrom(isolatedClientIp(), email, "123456")
            );
        });
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

        it("should answer 429 after too many wrong codes for one e-mail, whatever its case", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await confirmReset(attempt % 2 ? email.toUpperCase() : email).expect(400);
            }

            const limited: supertest.Response = await confirmReset(email);
            expectRateLimited(limited);
            expectPolicies(limited, [FAILED_ATTEMPTS_PER_IP]);
            await confirmReset(testEmailOf(`rl${randomHex(5)}`)).expect(400);
        });

        it("should not show other clients' wrong codes for an address in the RateLimit headers", async (): Promise<void> => {
            await expectOwnCodeFailuresOnly(confirmReset);
        });

        it("should show the per-account count for one account in the RateLimit headers", async (): Promise<void> => {
            const response: supertest.Response = await confirmEmailWith(codeCheckingUser, {
                code: "123456"
            }).expect(400);

            expectFirstFailureCounts(response, [
                FAILED_ATTEMPTS_PER_IP,
                FAILED_ATTEMPTS_PER_ACCOUNT
            ]);
        });

        it("should answer 429 after too many wrong codes for one account", async (): Promise<void> => {
            const confirmEmail = (): supertest.Test =>
                confirmEmailWith(confirmingUser, { code: "123456" });

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await confirmEmail().expect(400);
            }

            expectRateLimited(await confirmEmail());
        });

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
        });
    });

    describe(`${CODE_FAILURES_PER_DAY} wrong codes a day`, (): void => {
        const fromIsolatedIp = (test: supertest.Test): supertest.Test =>
            test.set("X-Forwarded-For", isolatedClientIp());

        const storedAuthentication = async (user: TestUser) =>
            (
                await UserModel.findById(user.id)
                    .select(
                        "+authentication.passwordReset +authentication.passwordResetFailures +authentication.emailChange +authentication.emailChangeFailures"
                    )
                    .lean()
            ).authentication;

        const countedResetFailures = async (
            user: TestUser,
            count: number
        ): Promise<EmailCodeFailures> => {
            const deadline: number = Date.now() + 5000;
            let failures: EmailCodeFailures = (await storedAuthentication(user))
                .passwordResetFailures;

            while (failures?.count !== count && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                failures = (await storedAuthentication(user)).passwordResetFailures;
            }

            return failures;
        };

        const setFailures = (user: TestUser, field: string, failures: EmailCodeFailures) =>
            UserModel.updateOne(
                { _id: user.id },
                { $set: { [`authentication.${field}`]: failures } }
            );

        const setCodeField = (user: TestUser, field: string, value: number | Date) =>
            UserModel.updateOne({ _id: user.id }, { $set: { [`authentication.${field}`]: value } });

        const setResetCode = async (user: TestUser): Promise<string> => {
            const code: string = createEmailCode();

            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.passwordReset": {
                            hash: hashEmailCode(passwordResetScope(user.id, user.email), code),
                            sentAt: cooldownPassed(),
                            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
                            attempts: 0
                        }
                    }
                }
            );

            return code;
        };

        const confirmReset = (email: string, code: string): supertest.Test =>
            fromIsolatedIp(request(TestData.apiURL).post("/auth/password-reset/confirm")).send({
                email,
                code,
                newPassword: randomHex(12)
            });

        const changeEmail = (user: TestUser, email: string): supertest.Test =>
            fromIsolatedIp(request(TestData.apiURL).patch("/user/email"))
                .set("Cookie", user.cookie)
                .send({ email, password: user.password });

        const setChangeCode = async (user: TestUser, email: string): Promise<string> => {
            const code: string = createEmailCode();

            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.emailChange.hash": hashEmailCode(
                            emailChangeScope(user.id, email),
                            code
                        ),
                        "authentication.emailChange.sentAt": cooldownPassed()
                    }
                }
            );

            return code;
        };

        const confirmEmail = (user: TestUser, code: string): supertest.Test =>
            fromIsolatedIp(request(TestData.apiURL).post("/user/email/confirm"))
                .set("Cookie", user.cookie)
                .send({ code });

        const registration = (email: string): Record<string, unknown> => ({
            email,
            username: `rl${randomHex(5)}`,
            password: randomHex(12)
        });

        const registrationFailures = async (email: string): Promise<EmailCodeFailures> =>
            (await PendingRegistrationModel.findOne({ email }).lean()).failures;

        const setRegistrationFailures = (email: string, failures: EmailCodeFailures) =>
            PendingRegistrationModel.updateOne({ email }, { $set: { failures } });

        const setRegistrationCodeField = (email: string, field: string, value: number | Date) =>
            PendingRegistrationModel.updateOne({ email }, { $set: { [`code.${field}`]: value } });

        const verify = (email: string, code: string, username?: string): supertest.Test =>
            fromIsolatedIp(request(TestData.apiURL).post("/auth/register/verify")).send({
                ...registration(email),
                ...(username && { username }),
                code
            });

        it("should answer a capped password reset like a wrong code for an unknown address, kept across resends", async (): Promise<void> => {
            const since: Date = hoursAgo(1);
            const code: string = await setResetCode(cappedUser);
            await setFailures(
                cappedUser,
                "passwordResetFailures",
                failuresOf(CODE_FAILURES_PER_DAY - 1, since)
            );

            await confirmReset(cappedUser.email, otherCode(code)).expect(400);
            expect((await storedAuthentication(cappedUser)).passwordResetFailures).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            await runRequestReset(cappedUser.email);
            const resent = await storedAuthentication(cappedUser);
            expect(resent.passwordReset).toMatchObject({ attempts: 0 });
            expect(resent.passwordResetFailures).toEqual(failuresOf(CODE_FAILURES_PER_DAY, since));

            const newCode: string = await setResetCode(cappedUser);
            const capped: supertest.Response = await confirmReset(cappedUser.email, newCode);
            const unknown: supertest.Response = await confirmReset(
                testEmailOf(`rl${randomHex(5)}`),
                newCode
            );

            expect(capped.status).toBe(400);
            expect(capped.body).toEqual({ error: Responses.EmailCodes.invalidCode });
            expect(capped.headers["retry-after"]).toBeUndefined();
            expect([unknown.status, unknown.body]).toEqual([capped.status, capped.body]);
            expect(await storedAuthentication(cappedUser)).toMatchObject({
                passwordReset: { attempts: 0 },
                passwordResetFailures: failuresOf(CODE_FAILURES_PER_DAY, since)
            });
            await loginFrom(isolatedClientIp(), cappedUser.email, cappedUser.password).expect(200);
        });

        it("should start the count over once its day is up and end it with a reset", async (): Promise<void> => {
            const code: string = await setResetCode(restartedUser);
            await setFailures(
                restartedUser,
                "passwordResetFailures",
                failuresOf(CODE_FAILURES_PER_DAY, hoursAgo(25))
            );

            await confirmReset(restartedUser.email, otherCode(code)).expect(400);
            const { passwordResetFailures } = await storedAuthentication(restartedUser);
            expect(passwordResetFailures.count).toBe(1);
            expect(Date.now() - passwordResetFailures.since.getTime()).toBeLessThan(60 * 1000);

            await confirmReset(restartedUser.email, code).expect(200);
            expect(await storedAuthentication(restartedUser)).not.toHaveProperty(
                "passwordResetFailures"
            );
        });

        it("should keep the count for one account across e-mail changes to other addresses", async (): Promise<void> => {
            const firstEmail: string = testEmailOf(`rl${randomHex(5)}`);
            const secondEmail: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(2);

            await changeEmail(switchingUser, firstEmail).expect(202);
            const code: string = await setChangeCode(switchingUser, firstEmail);
            await setFailures(
                switchingUser,
                "emailChangeFailures",
                failuresOf(CODE_FAILURES_PER_DAY - 1, since)
            );

            await confirmEmail(switchingUser, otherCode(code)).expect(400);

            await changeEmail(switchingUser, secondEmail).expect(202);
            expect(await storedAuthentication(switchingUser)).toMatchObject({
                emailChange: { email: secondEmail, attempts: 0 },
                emailChangeFailures: failuresOf(CODE_FAILURES_PER_DAY, since)
            });

            expectTooManyCodeFailures(
                await confirmEmail(switchingUser, await setChangeCode(switchingUser, secondEmail)),
                since
            );
            expect(
                await request(TestData.apiURL).get("/user").set("Cookie", switchingUser.cookie)
            ).toHaveProperty("body.email", switchingUser.email);
        });

        it("should keep the count when an e-mail change is confirmed or refused", async (): Promise<void> => {
            const failures: EmailCodeFailures = failuresOf(5, hoursAgo(1));
            const newEmail: string = testEmailOf(`rl${randomHex(5)}`);
            await setFailures(movingUser, "emailChangeFailures", failures);

            await changeEmail(movingUser, newEmail).expect(202);
            await confirmEmail(movingUser, await setChangeCode(movingUser, newEmail)).expect(200);
            expect(await storedAuthentication(movingUser)).toHaveProperty(
                "emailChangeFailures",
                failures
            );

            await changeEmail(movingUser, uncheckedUser.email).expect(202);
            await confirmEmail(
                movingUser,
                await setChangeCode(movingUser, uncheckedUser.email)
            ).expect(409);
            expect(await storedAuthentication(movingUser)).toHaveProperty(
                "emailChangeFailures",
                failures
            );
        });

        it("should keep the count for a registration across re-registrations and resends", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(3);
            const passCooldown = () =>
                PendingRegistrationModel.updateOne(
                    { email },
                    { $set: { "code.sentAt": cooldownPassed() } }
                );

            await registerRequest(registration(email)).expect(202);
            const code: string = await setRegistrationCode(email);
            await setRegistrationFailures(email, failuresOf(CODE_FAILURES_PER_DAY - 1, since));

            await verify(email, otherCode(code)).expect(400);
            expect(await registrationFailures(email)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            await passCooldown();
            await registerRequest(registration(email)).expect(202);
            expect(await registrationFailures(email)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            await passCooldown();
            expect(await runResendRegistration(email)).toHaveProperty("status", 200);
            expect(await registrationFailures(email)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            expectTooManyCodeFailures(await verify(email, await setRegistrationCode(email)), since);
        });

        it("should not count a right code refused for a taken username", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const failures: EmailCodeFailures = failuresOf(5, hoursAgo(1));

            await registerRequest(registration(email)).expect(202);
            const code: string = await setRegistrationCode(email);
            await setRegistrationFailures(email, failures);

            await verify(email, code, guessedUser.username).expect(409);
            expect(await registrationFailures(email)).toEqual(failures);
        });

        it("should count password reset tries on a used-up or expired code", async (): Promise<void> => {
            const since: Date = hoursAgo(1);
            await setFailures(spentResetUser, "passwordResetFailures", failuresOf(5, since));

            const usedUpCode: string = await setResetCode(spentResetUser);
            await setCodeField(spentResetUser, "passwordReset.attempts", EMAIL_CODE_MAX_ATTEMPTS);
            await confirmReset(spentResetUser.email, usedUpCode).expect(400);
            expect(await countedResetFailures(spentResetUser, 6)).toEqual(failuresOf(6, since));
            expect(await storedAuthentication(spentResetUser)).toHaveProperty(
                "passwordReset.attempts",
                EMAIL_CODE_MAX_ATTEMPTS
            );

            const expiredCode: string = await setResetCode(spentResetUser);
            await setCodeField(spentResetUser, "passwordReset.expiresAt", hoursAgo(1));
            await confirmReset(spentResetUser.email, expiredCode).expect(400);
            expect(await countedResetFailures(spentResetUser, 7)).toEqual(failuresOf(7, since));
            expect(await storedAuthentication(spentResetUser)).toHaveProperty(
                "passwordReset.attempts",
                0
            );
        });

        it("should not count password reset tries with no code requested within the day", async (): Promise<void> => {
            const since: Date = hoursAgo(1);
            await setFailures(
                uncodedResetUser,
                "passwordResetFailures",
                failuresOf(CODE_FAILURES_PER_DAY - 2, since)
            );

            const unknown: supertest.Response = await confirmReset(
                testEmailOf(`rl${randomHex(5)}`),
                createEmailCode()
            );
            const uncoded: supertest.Response = await confirmReset(
                uncodedResetUser.email,
                createEmailCode()
            );
            expect(uncoded.status).toBe(400);
            expect(uncoded.body).toEqual({ error: Responses.EmailCodes.invalidCode });
            expect(uncoded.headers["retry-after"]).toBeUndefined();
            expect([unknown.status, unknown.body]).toEqual([uncoded.status, uncoded.body]);
            expect(await storedAuthentication(uncodedResetUser)).not.toHaveProperty(
                "passwordReset"
            );

            const oldCode: string = await setResetCode(uncodedResetUser);
            await setCodeField(uncodedResetUser, "passwordReset.sentAt", hoursAgo(25));
            await setCodeField(uncodedResetUser, "passwordReset.expiresAt", hoursAgo(24));
            const old: supertest.Response = await confirmReset(uncodedResetUser.email, oldCode);
            expect([old.status, old.body]).toEqual([uncoded.status, uncoded.body]);

            const code: string = await setResetCode(uncodedResetUser);
            await confirmReset(uncodedResetUser.email, otherCode(code)).expect(400);
            expect(await countedResetFailures(uncodedResetUser, CODE_FAILURES_PER_DAY - 1)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY - 1, since)
            );

            await confirmReset(uncodedResetUser.email, code).expect(200);
        });

        it("should start the password reset count over on a try on a used-up code once its day is up", async (): Promise<void> => {
            await setFailures(
                restartedSpentResetUser,
                "passwordResetFailures",
                failuresOf(CODE_FAILURES_PER_DAY, hoursAgo(25))
            );
            const code: string = await setResetCode(restartedSpentResetUser);
            await setCodeField(
                restartedSpentResetUser,
                "passwordReset.attempts",
                EMAIL_CODE_MAX_ATTEMPTS
            );

            await confirmReset(restartedSpentResetUser.email, code).expect(400);
            const failures: EmailCodeFailures = await countedResetFailures(
                restartedSpentResetUser,
                1
            );
            expect(failures.count).toBe(1);
            expect(Date.now() - failures.since.getTime()).toBeLessThan(60 * 1000);
        });

        it("should refuse a right password reset code like a wrong one once tries on spent codes reach the cap", async (): Promise<void> => {
            const since: Date = hoursAgo(1);
            await setFailures(
                cappedSpentResetUser,
                "passwordResetFailures",
                failuresOf(CODE_FAILURES_PER_DAY - 2, since)
            );

            const usedUpCode: string = await setResetCode(cappedSpentResetUser);
            await setCodeField(
                cappedSpentResetUser,
                "passwordReset.attempts",
                EMAIL_CODE_MAX_ATTEMPTS
            );
            await confirmReset(cappedSpentResetUser.email, usedUpCode).expect(400);
            expect(
                await countedResetFailures(cappedSpentResetUser, CODE_FAILURES_PER_DAY - 1)
            ).toEqual(failuresOf(CODE_FAILURES_PER_DAY - 1, since));

            const expiredCode: string = await setResetCode(cappedSpentResetUser);
            await setCodeField(cappedSpentResetUser, "passwordReset.expiresAt", hoursAgo(1));
            await confirmReset(cappedSpentResetUser.email, expiredCode).expect(400);
            expect(await countedResetFailures(cappedSpentResetUser, CODE_FAILURES_PER_DAY)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            const capped: supertest.Response = await confirmReset(
                cappedSpentResetUser.email,
                await setResetCode(cappedSpentResetUser)
            );

            expect(capped.status).toBe(400);
            expect(capped.body).toEqual({ error: Responses.EmailCodes.invalidCode });
            expect(capped.headers["retry-after"]).toBeUndefined();
            expect(
                (await storedAuthentication(cappedSpentResetUser)).passwordResetFailures
            ).toEqual(failuresOf(CODE_FAILURES_PER_DAY, since));
            await loginFrom(
                isolatedClientIp(),
                cappedSpentResetUser.email,
                cappedSpentResetUser.password
            ).expect(200);
        });

        it("should count verify tries on a used-up, expired or missing registration code", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(1);

            await registerRequest(registration(email)).expect(202);
            const code: string = await setRegistrationCode(email);
            await setRegistrationFailures(email, failuresOf(5, since));

            await setRegistrationCodeField(email, "attempts", EMAIL_CODE_MAX_ATTEMPTS);
            await verify(email, code).expect(400);
            expect(await registrationFailures(email)).toEqual(failuresOf(6, since));

            await setRegistrationCodeField(email, "attempts", 0);
            await setRegistrationCodeField(email, "expiresAt", hoursAgo(1));
            await verify(email, code).expect(400);
            expect(await registrationFailures(email)).toEqual(failuresOf(7, since));

            const unregistered: string = testEmailOf(`rl${randomHex(5)}`);
            await verify(unregistered, code).expect(400);
            expect(await PendingRegistrationModel.exists({ email: unregistered })).toBeNull();
        });

        it("should start a registration's count over on a try on an expired code once its day is up", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);

            await registerRequest(registration(email)).expect(202);
            const code: string = await setRegistrationCode(email);
            await setRegistrationFailures(email, failuresOf(CODE_FAILURES_PER_DAY, hoursAgo(25)));
            await setRegistrationCodeField(email, "expiresAt", hoursAgo(1));

            const restarted: supertest.Response = await verify(email, code).expect(400);
            expect(restarted.body).toEqual({ error: Responses.EmailCodes.invalidCode });
            const failures: EmailCodeFailures = await registrationFailures(email);
            expect(failures.count).toBe(1);
            expect(Date.now() - failures.since.getTime()).toBeLessThan(60 * 1000);
        });

        it("should answer the try on a used-up registration code that reaches the cap with 400 and the right code after it with 429", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(1);

            await registerRequest(registration(email)).expect(202);
            const usedUpCode: string = await setRegistrationCode(email);
            await setRegistrationFailures(email, failuresOf(CODE_FAILURES_PER_DAY - 1, since));
            await setRegistrationCodeField(email, "attempts", EMAIL_CODE_MAX_ATTEMPTS);

            const reaching: supertest.Response = await verify(email, usedUpCode).expect(400);
            expect(reaching.body).toEqual({ error: Responses.EmailCodes.invalidCode });
            expect(await registrationFailures(email)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            await setRegistrationCodeField(email, "attempts", 0);
            expectTooManyCodeFailures(await verify(email, await setRegistrationCode(email)), since);
            expect(await registrationFailures(email)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );
            expect(await PendingRegistrationModel.exists({ email })).toBeTruthy();
        });

        it("should count e-mail confirm tries on a missing, used-up or expired code", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(1);
            await setFailures(spentChangeUser, "emailChangeFailures", failuresOf(5, since));

            await confirmEmail(spentChangeUser, createEmailCode()).expect(400);
            const missing = await storedAuthentication(spentChangeUser);
            expect(missing.emailChangeFailures).toEqual(failuresOf(6, since));
            expect(missing).not.toHaveProperty("emailChange");

            await changeEmail(spentChangeUser, newEmail).expect(202);
            const code: string = await setChangeCode(spentChangeUser, newEmail);
            await setCodeField(spentChangeUser, "emailChange.attempts", EMAIL_CODE_MAX_ATTEMPTS);
            await confirmEmail(spentChangeUser, code).expect(400);
            expect((await storedAuthentication(spentChangeUser)).emailChangeFailures).toEqual(
                failuresOf(7, since)
            );

            await setCodeField(spentChangeUser, "emailChange.attempts", 0);
            await setCodeField(spentChangeUser, "emailChange.expiresAt", hoursAgo(1));
            await confirmEmail(spentChangeUser, code).expect(400);
            expect(await storedAuthentication(spentChangeUser)).toMatchObject({
                emailChange: { email: newEmail, attempts: 0 },
                emailChangeFailures: failuresOf(8, since)
            });
        });

        it("should answer the e-mail confirm try on an expired code that reaches the cap with 400 and the right code after it with 429", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(1);

            await changeEmail(cappedSpentChangeUser, newEmail).expect(202);
            const expiredCode: string = await setChangeCode(cappedSpentChangeUser, newEmail);
            await setCodeField(cappedSpentChangeUser, "emailChange.expiresAt", hoursAgo(1));
            await setFailures(
                cappedSpentChangeUser,
                "emailChangeFailures",
                failuresOf(CODE_FAILURES_PER_DAY - 1, since)
            );

            const reaching: supertest.Response = await confirmEmail(
                cappedSpentChangeUser,
                expiredCode
            ).expect(400);
            expect(reaching.body).toEqual({ error: Responses.EmailCodes.invalidCode });
            expect((await storedAuthentication(cappedSpentChangeUser)).emailChangeFailures).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );

            await setCodeField(
                cappedSpentChangeUser,
                "emailChange.expiresAt",
                new Date(Date.now() + 60 * 60 * 1000)
            );
            expectTooManyCodeFailures(
                await confirmEmail(
                    cappedSpentChangeUser,
                    await setChangeCode(cappedSpentChangeUser, newEmail)
                ),
                since
            );
            expect((await storedAuthentication(cappedSpentChangeUser)).emailChangeFailures).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );
            expect(
                await request(TestData.apiURL)
                    .get("/user")
                    .set("Cookie", cappedSpentChangeUser.cookie)
            ).toHaveProperty("body.email", cappedSpentChangeUser.email);
        });

        it("should not let parallel wrong codes pass the count", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            const since: Date = hoursAgo(1);

            await registerRequest(registration(email)).expect(202);
            const code: string = await setRegistrationCode(email);
            await setRegistrationFailures(email, failuresOf(CODE_FAILURES_PER_DAY - 1, since));

            const statuses: number[] = (
                await Promise.all(
                    Array.from({ length: 4 }, (): supertest.Test => verify(email, otherCode(code)))
                )
            ).map((response: supertest.Response) => response.status);

            expect(statuses.sort()).toEqual([400, 429, 429, 429]);
            expect(await registrationFailures(email)).toEqual(
                failuresOf(CODE_FAILURES_PER_DAY, since)
            );
        });
    });

    describe("POST /auth/password-reset/confirm-link", (): void => {
        const confirmLinkFrom = (clientIp: string, token: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/password-reset/confirm-link")
                .set("X-Forwarded-For", clientIp)
                .send({ token, newPassword: randomHex(12) });

        const wrongToken = (): string => `${randomHex(12)}.${randomHex(16)}`;

        it("should answer 429 after too many wrong links from one IP", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: FAILED_ATTEMPTS_PER_IP }, (): supertest.Test =>
                    confirmLinkFrom(clientIp, wrongToken())
                )
            );

            expect(responses.map((response: supertest.Response) => response.status)).toEqual(
                Array(FAILED_ATTEMPTS_PER_IP).fill(400)
            );
            expectRateLimited(await confirmLinkFrom(clientIp, wrongToken()));
            await confirmLinkFrom(isolatedClientIp(), wrongToken()).expect(400);
        });
    });
});
