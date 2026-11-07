import request from "supertest";
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_SECONDS } from "../constants/limits";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { PendingRegistrationModel } from "../database/pendingRegistrations";
import { authentication, random } from "../helpers";
import { generateRandomString } from "../helpers/text";
import { sessionCookie } from "../helpers/session";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    expectHostOnlySessionCookie,
    linkGithub,
    login,
    isolatedClientIp,
    randomHex,
    registerRequest,
    scryptHashPattern,
    setRegistrationCode,
    storeSession,
    storedAuthentication,
    testEmailOf,
    testEmailOfLength,
    verifyRegistration,
    verifyRequest
} from "./helpers/testUsers";
import { describeWithGithub, itWithGithub } from "./helpers/githubTests";
import { runResendRegistration } from "./helpers/emailHandlers";
import supertest from "supertest";

const registerAndVerify = async (body: Record<string, string>): Promise<supertest.Response> => {
    await registerRequest(body).expect(202);

    return verifyRegistration(
        body.email,
        await setRegistrationCode(body.email),
        body.username,
        body.password
    ).expect(201);
};

const resendRequest = (body: Record<string, unknown>): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/register/resend")
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const allowResend = (email: string): Promise<unknown> =>
    PendingRegistrationModel.updateOne(
        { email },
        { $set: { "code.sentAt": new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000) } }
    );

const pendingRegistrationOf = (email: string) => PendingRegistrationModel.findOne({ email }).lean();

const replacedCodeOf = async (email: string, earlierHash: string, triesLeft: number = 40) => {
    const { code } = await pendingRegistrationOf(email);
    if (code.hash !== earlierHash || triesLeft === 0) {
        return code;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    return replacedCodeOf(email, earlierHash, triesLeft - 1);
};

const usernameCheck = (query: string | Record<string, string>): supertest.Test =>
    request(TestData.apiURL)
        .get("/auth/username-available")
        .set("X-Forwarded-For", isolatedClientIp())
        .query(query);

describe("Authentication API Tests", (): void => {
    let user: TestUser;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser();
    });

    describe("POST /auth/login", (): void => {
        it("should log in a user successfully with valid credentials", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: user.password })
                .expect(200);

            expect(response.headers["set-cookie"]).toBeDefined();
            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.loginSuccess(user.username)
            );
        });

        it("should log in whatever the case of the e-mail", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: ` ${user.email.toUpperCase()} `, password: user.password })
                .expect(200);

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.loginSuccess(user.username)
            );
        });

        it("should return 400 when nothing is provided", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 400 when the e-mail is only whitespace", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: "   ", password: user.password })
                .expect(400);

            expect(response.body).toEqual({
                error: Responses.Authentication.missingEmailPassword
            });
        });

        it("should return 400 when no e-mail is provided", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ password: user.password })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 400 when no password is provided", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 403 when the password is incorrect", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: "foo" })
                .expect(403);

            expect(response.body).toEqual({ error: Responses.Authentication.invalidCredentials });
        });

        it("should return 403 when there is no such user in the database", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmailOf(`nouser${randomHex(5)}`), password: "foo" })
                .expect(403);

            expect(response.body).toEqual({ error: Responses.Authentication.invalidCredentials });
        });

        it("should answer an unknown address, a wrong password and an account without one alike", async (): Promise<void> => {
            const passwordUser: TestUser = await createTestUser("same");
            const githubOnlyUser: TestUser = await createTestUser("sameg");
            const legacyUser: TestUser = await createTestUser("samel");
            const legacySalt: string = random();

            await UserModel.updateOne(
                { _id: githubOnlyUser.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}` },
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                }
            );
            await UserModel.updateOne(
                { _id: legacyUser.id },
                {
                    $set: {
                        "authentication.salt": legacySalt,
                        "authentication.password": authentication(legacySalt, legacyUser.password)
                    }
                }
            );

            const responses: supertest.Response[] = await Promise.all(
                [
                    testEmailOf(`nouser${randomHex(5)}`),
                    passwordUser.email,
                    githubOnlyUser.email,
                    legacyUser.email
                ].map((email: string) =>
                    request(TestData.apiURL)
                        .post("/auth/login")
                        .set("X-Forwarded-For", isolatedClientIp())
                        .send({ email, password: randomHex(12) })
                )
            );

            for (const response of responses) {
                expect(response.status).toBe(403);
                expect(response.body).toEqual({
                    error: Responses.Authentication.invalidCredentials
                });
                expect(response.headers["set-cookie"]).toBeUndefined();
            }
        });

        it("should set session cookie with correct attributes", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: user.password })
                .expect(200);

            const cookie: string = response.headers["set-cookie"][0];

            expect(sessionCookie).toBe("__Host-VB-AUTH");
            expect(cookie).toMatch(/^__Host-VB-AUTH=[^;]+/);
            expectHostOnlySessionCookie(cookie);
        });

        it("should not leak sensitive fields in response", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: user.password })
                .expect(200);

            expect(response.body).not.toHaveProperty("authentication.password");
            expect(response.body).not.toHaveProperty("authentication.salt");
        });

        it("should handle malformed JSON gracefully", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .set("Content-Type", "application/json")
                .send('{"email": "foo", "password": ') // malformed JSON
                .catch((e) => e.response); // supertest throws on malformed JSON

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        describe("with a password shorter than the current rules", (): void => {
            let legacyUser: TestUser;
            const legacyPassword: string = "short";

            beforeAll(async (): Promise<void> => {
                legacyUser = await createTestUser("old");

                const salt: string = random();
                await UserModel.updateOne(
                    { _id: legacyUser.id },
                    {
                        $set: {
                            "authentication.salt": salt,
                            "authentication.password": authentication(salt, legacyPassword)
                        }
                    }
                );
            });

            it("should still log in", async (): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/login")
                    .send({ email: legacyUser.email, password: legacyPassword })
                    .expect(200);

                expect(response.body).toHaveProperty(
                    "message",
                    Responses.Authentication.loginSuccess(legacyUser.username)
                );
            });
        });

        describe("password hashes", (): void => {
            const legacyUserWithHash = async (): Promise<[TestUser, string]> => {
                const legacyUser: TestUser = await createTestUser("hmac");
                const salt: string = random();

                await UserModel.updateOne(
                    { _id: legacyUser.id },
                    {
                        $set: {
                            "authentication.salt": salt,
                            "authentication.password": authentication(salt, legacyUser.password)
                        }
                    }
                );

                return [legacyUser, salt];
            };

            it("should log in and upgrade the hash to scrypt", async (): Promise<void> => {
                const [legacyUser, legacySalt] = await legacyUserWithHash();

                await login(legacyUser.email, legacyUser.password);

                const { salt, password } = await storedAuthentication(legacyUser.id);
                expect(password).toMatch(scryptHashPattern);
                expect(salt).not.toBe(legacySalt);

                await login(legacyUser.email, legacyUser.password);
                expect((await storedAuthentication(legacyUser.id)).password).toBe(password);
            });

            it("should keep the legacy hash after a wrong password", async (): Promise<void> => {
                const [legacyUser, legacySalt] = await legacyUserWithHash();

                await request(TestData.apiURL)
                    .post("/auth/login")
                    .set("X-Forwarded-For", isolatedClientIp())
                    .send({ email: legacyUser.email, password: `${legacyUser.password}!` })
                    .expect(403);

                expect(await storedAuthentication(legacyUser.id)).toMatchObject({
                    salt: legacySalt,
                    password: authentication(legacySalt, legacyUser.password)
                });
            });

            it("should store new passwords as scrypt hashes", async (): Promise<void> => {
                const newUser: TestUser = await createTestUser("kdf");

                expect((await storedAuthentication(newUser.id)).password).toMatch(
                    scryptHashPattern
                );
            });
        });
    });

    describe("POST /auth/logout", (): void => {
        let loggedOutUser: TestUser;

        beforeAll(async (): Promise<void> => {
            loggedOutUser = await createTestUser("logout");
        });

        it("should clear the session cookie and invalidate the session", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/logout")
                .set("Cookie", loggedOutUser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.Authentication.logoutSuccess);

            const cookie: string = response.headers["set-cookie"][0];
            expect(cookie).toMatch(new RegExp(`^${sessionCookie}=;`));
            expectHostOnlySessionCookie(cookie);

            const expires: string = cookie.match(/Expires=([^;]+)/)[1];
            expect(new Date(expires).getTime()).toBeLessThan(Date.now());

            await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", loggedOutUser.cookie)
                .expect(403);
        });

        it("should return 200 without a session cookie", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/logout")
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.Authentication.logoutSuccess);
        });
    });

    describe("POST /auth/register", (): void => {
        let testEmail: string;
        let testUsername: string;
        let testPassword: string = generateRandomString(8);
        let existingUser: TestUser;
        let upperCaseUser: TestUser;

        beforeAll(async (): Promise<void> => {
            [existingUser, upperCaseUser] = await Promise.all([createTestUser(), createTestUser()]);
        });

        it("should send a code instead of creating the account", async (): Promise<void> => {
            const username: string = `t${randomHex(5)}`;
            const email: string = testEmailOf(username);

            const response: supertest.Response = await registerRequest({
                email,
                password: testPassword,
                username
            }).expect(202);

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationCodeSent(email)
            );
            expect(response.headers["set-cookie"]).toBeUndefined();
            expect(await UserModel.exists({ email })).toBeNull();
            const pending = await pendingRegistrationOf(email);
            expect(pending).toMatchObject({ code: { attempts: 0 } });
            expect(pending).not.toHaveProperty("username");
            expect(pending).not.toHaveProperty("authentication");

            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email, password: testPassword })
                .expect(403);
        });

        it("should register a new user successfully with the code", async (): Promise<void> => {
            testUsername = `t${generateRandomString(10)}`;
            testEmail = testEmailOf(testUsername);

            const response: supertest.Response = await registerAndVerify({
                email: testEmail,
                password: testPassword,
                username: testUsername
            });

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(testUsername)
            );

            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", response.headers["set-cookie"][0])
                .expect(200);

            expect(userResponse.body).toMatchObject({
                username: testUsername,
                email: testEmail,
                hasPassword: true,
                emailVerified: true
            });
            expect(await pendingRegistrationOf(testEmail)).toBeNull();

            await login(testEmail, testPassword);
        });

        const paddedUpperCase = (email: string): string => ` ${email.toUpperCase()} `;

        test.each([
            ["an existing e-mail", (): string => existingUser.email, (email: string) => email],
            [
                "an upper-case copy of an existing e-mail",
                (): string => upperCaseUser.email,
                paddedUpperCase
            ],
            [
                "an upper-case copy of SUPERUSER_EMAIL",
                (): string => TestData.superuser.email,
                paddedUpperCase
            ]
        ])(
            "should answer %s like a new one and report the conflict at verify",
            async (
                _: string,
                existingEmail: () => string,
                asSent: (email: string) => string
            ): Promise<void> => {
                const email: string = existingEmail();

                const response: supertest.Response = await registerRequest({
                    email: asSent(email),
                    password: testPassword,
                    username: `t${generateRandomString(10)}`
                }).expect(202);

                expect(response.body).toEqual({
                    message: Responses.Authentication.registrationCodeSent(email)
                });
                expect(response.headers["set-cookie"]).toBeUndefined();

                const verifyResponse: supertest.Response = await verifyRegistration(
                    email,
                    await setRegistrationCode(email)
                ).expect(409);

                expect(verifyResponse.body).toHaveProperty(
                    "error",
                    Responses.Authentication.emailAlreadyExists
                );
                expect(await pendingRegistrationOf(email)).toBeNull();
                expect(await UserModel.countDocuments({ email })).toBe(1);
            }
        );

        it("should keep the existing account's password", async (): Promise<void> => {
            await expect(login(existingUser.email, existingUser.password)).resolves.toMatch(
                `${sessionCookie}=`
            );
            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: existingUser.email, password: testPassword })
                .expect(403);
        });

        it("should store the e-mail lower-cased", async (): Promise<void> => {
            const username: string = `t${generateRandomString(10)}`;
            const email: string = testEmailOf(username);

            await registerAndVerify({
                email: email.toUpperCase(),
                password: testPassword,
                username
            });

            const cookie: string = await login(email, testPassword);
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", email);
            expect(response.body).toHaveProperty("isSuperuser", false);
        });

        it("should not let the user register with an existing username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = user.username;

            const response: supertest.Response = await registerRequest({
                email: testEmail,
                password: testPassword,
                username: testUsername
            }).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
        });

        it("should not let the user register with a whitespace-padded existing username", async (): Promise<void> => {
            const response: supertest.Response = await registerRequest({
                email: testEmailOf(`t${generateRandomString(10)}`),
                password: testPassword,
                username: ` ${user.username} `
            }).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
        });

        it("should not let the user register with an existing username in another case", async (): Promise<void> => {
            const response: supertest.Response = await registerRequest({
                email: testEmailOf(`t${generateRandomString(10)}`),
                password: testPassword,
                username: user.username.toUpperCase()
            }).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
        });

        it("should answer 429 to parallel registrations with the same e-mail", async (): Promise<void> => {
            const email: string = testEmailOf(`t${randomHex(5)}`);

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 5 }, (): supertest.Test =>
                    registerRequest({ email, username: `t${randomHex(5)}`, password: testPassword })
                )
            );

            expect(
                responses
                    .map((response: supertest.Response): number => response.status)
                    .sort((a: number, b: number): number => a - b)
            ).toEqual([202, 429, 429, 429, 429]);
        });

        it("should answer 429 when registering again within the cooldown", async (): Promise<void> => {
            const email: string = testEmailOf(`t${randomHex(5)}`);
            await registerRequest({ email, username: `t${randomHex(5)}`, password: testPassword });

            const response: supertest.Response = await registerRequest({
                email,
                username: `t${randomHex(5)}`,
                password: testPassword
            }).expect(429);

            expect(response.body.retryAfter).toBeGreaterThan(0);
            expect(response.body.retryAfter).toBeLessThanOrEqual(EMAIL_CODE_RESEND_SECONDS);
            expect(response.headers["retry-after"]).toBe(String(response.body.retryAfter));
            expect(response.body).toHaveProperty(
                "error",
                Responses.EmailCodes.resendTooSoon(response.body.retryAfter)
            );
        });

        it("should keep the confirming party's password when someone registers the address again", async (): Promise<void> => {
            const email: string = testEmailOf(`t${randomHex(5)}`);
            const username: string = `t${randomHex(5)}`;
            const otherPassword: string = generateRandomString(12);
            await registerRequest({ email, username, password: testPassword }).expect(202);
            await allowResend(email);

            await registerRequest({
                email,
                username: `t${randomHex(5)}`,
                password: otherPassword
            }).expect(202);

            const response: supertest.Response = await verifyRegistration(
                email,
                await setRegistrationCode(email),
                username,
                testPassword
            ).expect(201);

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(username)
            );
            await login(email, testPassword);
            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email, password: otherPassword })
                .expect(403);
        });

        it("should drop the credentials a pending registration from before kept", async (): Promise<void> => {
            const email: string = testEmailOf(`t${randomHex(5)}`);
            const salt: string = random();
            await PendingRegistrationModel.collection.insertOne({
                email,
                username: `t${randomHex(5)}`,
                authentication: { salt, password: authentication(salt, testPassword) },
                code: {
                    hash: randomHex(32),
                    sentAt: new Date(0),
                    expiresAt: new Date(Date.now() + 60 * 1000),
                    attempts: 0
                },
                expiresAt: new Date(Date.now() + 60 * 1000)
            });

            await registerRequest({
                email,
                username: `t${randomHex(5)}`,
                password: testPassword
            }).expect(202);

            const pending = await PendingRegistrationModel.collection.findOne({ email });
            expect(pending).toMatchObject({ email, code: { attempts: 0 } });
            expect(pending).not.toHaveProperty("username");
            expect(pending).not.toHaveProperty("authentication");
        });

        it("should not let the user register with a too short (2- char) username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = "a";

            const response: supertest.Response = await registerRequest({
                email: testEmail,
                password: testPassword,
                username: testUsername
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.usernameTooShort
            );
        });

        it("should not let the user register with a whitespace-padded too short username", async (): Promise<void> => {
            const response: supertest.Response = await registerRequest({
                email: testEmailOf(`t${generateRandomString(10)}`),
                password: testPassword,
                username: "  a  "
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.usernameTooShort
            );
        });

        it("should not let the user register with a too long (16+ char) username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = "0123456789abcdefg";

            const response: supertest.Response = await registerRequest({
                email: testEmail,
                password: testPassword,
                username: testUsername
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTooLong);
        });

        test.each([
            ["only word joiners", "\u2060\u2060"],
            ["a zero-width space", "a\u200b"],
            ["a tab inside", "Rv\tBase"],
            ["a line break inside", "Rv\nBase"],
            ["a non-breaking space inside", "Rv\u00a0Base"],
            ["a control character", "Rv\u0007Base"],
            ["a zero-width joiner", "\u{1F468}\u200d\u{1F469}"],
            ["a zero-width non-joiner", "ab\u200c"],
            ["only braille blanks", "\u2800\u2800"],
            ["only Hangul fillers", "\u3164\u3164"],
            ["a cantillation mark the collation ignores", "a\u0591"],
            ["a tatweel", "a\u0640"],
            ["a private-use character", "ab\ue000"],
            ["an unassigned code point", "ab\u{50000}"],
            ["a noncharacter", "ab\uffff"],
            ["a lone surrogate", "a\ud83d"],
            ["another variation selector", "ab\u{E0100}"],
            ["a presentation selector after a letter", "ab\ufe0f"],
            ["two presentation selectors after a letter", "ab\ufe0f\ufe0f"]
        ])(
            "should not let the user register with a username with %s",
            async (_: string, username: string): Promise<void> => {
                const response: supertest.Response = await registerRequest({
                    email: testEmailOf(`un${randomHex(5)}`),
                    password: testPassword,
                    username
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.usernameInvalidCharacters
                );
            }
        );

        test.each([
            ["an inner space", (): string => `Rv ${randomHex(5)}`],
            ["accents", (): string => `R\u00e9${randomHex(5)}\u00e1`],
            ["an emoji", (): string => `\u{1F600}${randomHex(5)}`],
            ["emoji presentation selectors", (): string => `❤\ufe0f❤\ufe0e${randomHex(5)}`],
            ["a heart emoji", (): string => `❤\ufe0fl9${randomHex(5)}`],
            ["a keycap emoji", (): string => `1\ufe0f\u20e3l9${randomHex(5)}`]
        ])(
            "should register a user with a username with %s",
            async (_: string, makeUsername: () => string): Promise<void> => {
                const username: string = makeUsername();
                const email: string = testEmailOf(`un${randomHex(5)}`);

                const response: supertest.Response = await registerAndVerify({
                    email,
                    password: testPassword,
                    username
                });

                expect(response.body).toHaveProperty(
                    "message",
                    Responses.Authentication.registrationSuccess(username)
                );
            }
        );

        test.each([
            ["only combining marks", "\u0301\u0301"],
            ["three combining marks", "\u0300\u0301\u0302"],
            ["a decomposed é", "e\u0301"],
            ["one letter and 14 combining marks", `a${"\u0301".repeat(14)}`],
            ["one emoji letter and a presentation selector", "❤\ufe0f"],
            ["a lone emoji", "\u{1F600}"],
            ["a lone supplementary CJK character", "\u{20000}"]
        ])(
            "should not let the user register with %s as a too short username",
            async (_: string, username: string): Promise<void> => {
                const response: supertest.Response = await registerRequest({
                    email: testEmailOf(`un${randomHex(5)}`),
                    password: testPassword,
                    username
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.usernameTooShort
                );
            }
        );

        test.each([
            [7, Responses.Authentication.passwordTooShort],
            [129, Responses.Authentication.passwordTooLong]
        ])(
            "should not let the user register with a %i character password",
            async (length: number, error: string): Promise<void> => {
                const username: string = `pw${randomHex(5)}`;

                const response: supertest.Response = await registerRequest({
                    email: testEmailOf(username),
                    password: generateRandomString(length),
                    username
                }).expect(400);

                expect(response.body).toHaveProperty("error", error);
            }
        );

        it("should not let the user register with a 4 emoji password", async (): Promise<void> => {
            const username: string = `pw${randomHex(5)}`;

            const response: supertest.Response = await registerRequest({
                email: testEmailOf(username),
                password: "\u{1F600}".repeat(4),
                username
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.passwordTooShort
            );
        });

        it("should register a user with a 65 emoji password", async (): Promise<void> => {
            const username: string = `pw${randomHex(5)}`;
            const email: string = testEmailOf(username);
            const password: string = "\u{1F600}".repeat(65);

            const response: supertest.Response = await registerAndVerify({
                email,
                password,
                username
            });

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(username)
            );
            await login(email, password);
        });

        test.each([8, 128])(
            "should register a user with a %i character password",
            async (length: number): Promise<void> => {
                const username: string = `pw${randomHex(5)}`;
                const email: string = testEmailOf(username);
                const password: string = generateRandomString(length);

                const response: supertest.Response = await registerAndVerify({
                    email,
                    password,
                    username
                });

                expect(response.body).toHaveProperty(
                    "message",
                    Responses.Authentication.registrationSuccess(username)
                );
                await login(email, password);
            }
        );

        it("should not let the user register with an invalid e-mail regex", async (): Promise<void> => {
            testEmail = generateRandomString(8) + "@example"; //minus .com
            testUsername = generateRandomString(8);

            const response: supertest.Response = await registerRequest({
                email: testEmail,
                password: testPassword,
                username: testUsername
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.invalidEmailFormat
            );
        });

        test.each([
            ["two @ signs", `x@@${TestData.emailDomain}`],
            ["a leading dot in the domain", `x@.${TestData.emailDomain}`],
            ["a trailing dot in the domain", `x@${TestData.emailDomain}.`],
            ["two dots in a row in the domain", `x@${TestData.emailDomain.replace(".", "..")}`],
            ["over 254 characters", testEmailOfLength(255)],
            ["a trailing comment", "x@mailinator.com(c)"],
            ["a display name", "n<x@mailinator.com>"],
            ["a second address after a comma", "x@mailinator.com,y"],
            ["a comma in the local part", "a,b@evil.com"],
            ["a quoted local part", `"x"@${TestData.emailDomain}`],
            ["two dots in a row in the local part", `x..y@${TestData.emailDomain}`],
            ["a leading dot in the local part", `.x@${TestData.emailDomain}`],
            ["a trailing dot in the local part", `x.@${TestData.emailDomain}`],
            ["a leading hyphen in a domain label", `x@-${TestData.emailDomain}`],
            ["a domain label over 63 characters", `x@${"a".repeat(64)}.${TestData.emailDomain}`],
            ["a local part over 64 characters", testEmailOf(randomHex(5).padEnd(65, "a"))]
        ])(
            "should not let the user register with an e-mail with %s",
            async (_: string, email: string): Promise<void> => {
                const response: supertest.Response = await registerRequest({
                    email,
                    password: testPassword,
                    username: `em${randomHex(5)}`
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.invalidEmailFormat
                );
            }
        );

        it("should register a user with a +tag e-mail", async (): Promise<void> => {
            const username: string = `em${randomHex(5)}`;
            const email: string = testEmailOf(`${username}+tag`);

            await registerAndVerify({ email, password: testPassword, username });

            await login(email, testPassword);
        });

        test.each([
            ["a disposable address", "mailinator.com"],
            ["a subdomain of a disposable address", "inbox.mailinator.com"]
        ])(
            "should not let the user register with %s",
            async (_: string, domain: string): Promise<void> => {
                const username: string = `em${randomHex(5)}`;

                const response: supertest.Response = await registerRequest({
                    email: `${username}@${domain}`,
                    password: testPassword,
                    username
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.disposableEmail
                );
            }
        );

        it("should register a user with a 64 character local part", async (): Promise<void> => {
            const username: string = `em${randomHex(5)}`;
            const email: string = testEmailOf(username.padEnd(64, "a"));

            await registerAndVerify({ email, password: testPassword, username });

            await login(email, testPassword);
        });

        it("should register a user with a 254 character e-mail", async (): Promise<void> => {
            const username: string = `em${randomHex(5)}`;
            const email: string = testEmailOfLength(254);

            await registerAndVerify({ email, password: testPassword, username });

            await login(email, testPassword);
        });

        it("should not let the user register without a request body", async (): Promise<void> => {
            const response: supertest.Response = await registerRequest({}).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPasswordUsername
            );
        });

        test.each([
            ["null email", null, generateRandomString(8), generateRandomString(8)],
            ["null username", "user@example.test", null, generateRandomString(8)],
            ["null password", "user@example.test", generateRandomString(8), null],
            ["empty email", "", generateRandomString(8), generateRandomString(8)],
            ["empty username", "user@example.test", "", generateRandomString(8)],
            ["empty password", "user@example.test", generateRandomString(8), ""]
        ])(
            "should reject registration with %s",
            async (
                description: string,
                email: any,
                username: any,
                password: any
            ): Promise<void> => {
                const payload: any = {};
                if (email !== undefined) payload.email = email;
                if (username !== undefined) payload.username = username;
                if (password !== undefined) payload.password = password;

                const response: supertest.Response = await registerRequest(payload);

                expect(response.status).toBe(400);
            }
        );
    });

    describe("POST /auth/register/verify", (): void => {
        const password: string = generateRandomString(12);

        const pendingEmail = async (): Promise<string> => {
            const email: string = testEmailOf(`v${randomHex(5)}`);
            await registerRequest({ email, username: `v${randomHex(5)}`, password }).expect(202);
            return email;
        };

        const credentials = { username: `v${randomHex(5)}`, password };

        test.each([
            ["nothing", {}],
            ["no code", { email: testEmailOf(`v${randomHex(5)}`), ...credentials }],
            ["no e-mail", { code: "123456", ...credentials }],
            [
                "a numeric code",
                { email: testEmailOf(`v${randomHex(5)}`), code: 123456, ...credentials }
            ],
            ["no username", { email: testEmailOf(`v${randomHex(5)}`), code: "123456", password }],
            [
                "no password",
                {
                    email: testEmailOf(`v${randomHex(5)}`),
                    code: "123456",
                    username: credentials.username
                }
            ],
            [
                "a numeric password",
                {
                    email: testEmailOf(`v${randomHex(5)}`),
                    code: "123456",
                    username: credentials.username,
                    password: 12345678
                }
            ]
        ])(
            "should answer 400 to %s",
            async (_: string, body: Record<string, unknown>): Promise<void> => {
                const response: supertest.Response = await verifyRequest(body).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.missingEmailCodeUsernamePassword
                );
            }
        );

        it("should answer 400 to bad credentials without using up the code", async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);
            const username: string = `v${randomHex(5)}`;

            for (const [body, error] of [
                [{ username: "a", password }, Responses.Authentication.usernameTooShort],
                [{ username: "  a  ", password }, Responses.Authentication.usernameTooShort],
                [
                    { username: "\u2060\u2060", password },
                    Responses.Authentication.usernameInvalidCharacters
                ],
                [
                    { username: "a\u0591", password },
                    Responses.Authentication.usernameInvalidCharacters
                ],
                [{ username: "\u0301\u0301", password }, Responses.Authentication.usernameTooShort],
                [
                    { username: "Rv\tBase", password },
                    Responses.Authentication.usernameInvalidCharacters
                ],
                [{ username, password: "short" }, Responses.Authentication.passwordTooShort],
                [{ password }, Responses.Authentication.missingEmailCodeUsernamePassword],
                [{ username }, Responses.Authentication.missingEmailCodeUsernamePassword]
            ] as const) {
                const response: supertest.Response = await verifyRequest({
                    email,
                    code,
                    ...body
                }).expect(400);

                expect(response.body).toHaveProperty("error", error);
            }

            expect(await pendingRegistrationOf(email)).toMatchObject({ code: { attempts: 0 } });

            await verifyRegistration(email, code, username, password).expect(201);
            await login(email, password);
        });

        it("should answer 400 to an e-mail without a pending registration", async (): Promise<void> => {
            const response: supertest.Response = await verifyRegistration(
                testEmailOf(`v${randomHex(5)}`),
                "123456"
            ).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should answer 400 to a wrong code and still take the right one", async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);
            const wrongCode: string = code === "000000" ? "000001" : "000000";

            const response: supertest.Response = await verifyRegistration(email, wrongCode).expect(
                400
            );

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            expect(await pendingRegistrationOf(email)).toMatchObject({ code: { attempts: 1 } });

            await verifyRegistration(email, code).expect(201);
        });

        it("should accept a code with spaces and an upper-case e-mail", async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);

            await verifyRegistration(
                ` ${email.toUpperCase()} `,
                `${code.slice(0, 3)} ${code.slice(3)}`
            ).expect(201);
        });

        it(`should void the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong attempts`, async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);
            const wrongCode: string = code === "000000" ? "000001" : "000000";

            for (let attempt = 0; attempt < EMAIL_CODE_MAX_ATTEMPTS; attempt++) {
                await verifyRegistration(email, wrongCode).expect(400);
            }

            const response: supertest.Response = await verifyRegistration(email, code).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            expect(await UserModel.exists({ email })).toBeNull();
        });

        it("should answer 400 to an expired code", async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);
            await PendingRegistrationModel.updateOne(
                { email },
                { $set: { "code.expiresAt": new Date(Date.now() - 1000) } }
            );

            const response: supertest.Response = await verifyRegistration(email, code).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should answer 400 to a code that was already used", async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);

            await verifyRegistration(email, code).expect(201);
            const response: supertest.Response = await verifyRegistration(email, code).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should create one account from parallel verifications", async (): Promise<void> => {
            const email: string = await pendingEmail();
            const code: string = await setRegistrationCode(email);

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 4 }, (): supertest.Test => verifyRegistration(email, code))
            );

            expect(
                responses.filter((response: supertest.Response): boolean => response.status === 201)
            ).toHaveLength(1);
            expect(await UserModel.countDocuments({ email })).toBe(1);
        });

        it("should answer 409 to a taken username and still take the code with another one", async (): Promise<void> => {
            const username: string = `v${randomHex(5)}`;
            const [firstEmail, secondEmail] = [
                testEmailOf(`v${randomHex(5)}`),
                testEmailOf(`v${randomHex(5)}`)
            ];
            await registerRequest({ email: firstEmail, username, password }).expect(202);
            await registerRequest({ email: secondEmail, username, password }).expect(202);

            await verifyRegistration(
                firstEmail,
                await setRegistrationCode(firstEmail),
                username,
                password
            ).expect(201);
            const code: string = await setRegistrationCode(secondEmail);
            const response: supertest.Response = await verifyRegistration(
                secondEmail,
                code,
                username.toUpperCase(),
                password
            ).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
            expect(await pendingRegistrationOf(secondEmail)).toMatchObject({
                code: { attempts: 1 }
            });

            const otherUsername: string = `v${randomHex(5)}`;
            const retry: supertest.Response = await verifyRegistration(
                secondEmail,
                code,
                otherUsername,
                password
            ).expect(201);

            expect(retry.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(otherUsername)
            );
            expect(await pendingRegistrationOf(secondEmail)).toBeNull();
        });

        it("should answer 409 and drop the registration when the address got an account meanwhile", async (): Promise<void> => {
            await PendingRegistrationModel.create({
                email: user.email,
                code: {
                    hash: randomHex(32),
                    sentAt: new Date(),
                    expiresAt: new Date(Date.now() + 60 * 1000)
                },
                expiresAt: new Date(Date.now() + 60 * 1000)
            });

            const response: supertest.Response = await verifyRegistration(
                user.email,
                await setRegistrationCode(user.email)
            ).expect(409);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.emailAlreadyExists
            );
            expect(await pendingRegistrationOf(user.email)).toBeNull();
        });
    });

    describe("POST /auth/register/resend", (): void => {
        const password: string = generateRandomString(12);

        it("should answer 400 without an e-mail", async (): Promise<void> => {
            const response: supertest.Response = await resendRequest({}).expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.missingEmail);
        });

        it("should answer the same 200 to an e-mail without a pending registration", async (): Promise<void> => {
            const email: string = testEmailOf(`r${randomHex(5)}`);

            const response: supertest.Response = await resendRequest({ email }).expect(200);

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationCodeResent
            );
            expect(await pendingRegistrationOf(email)).toBeNull();
        });

        it("should answer the same 200 within the cooldown, without a new code", async (): Promise<void> => {
            const email: string = testEmailOf(`r${randomHex(5)}`);
            await registerRequest({ email, username: `r${randomHex(5)}`, password }).expect(202);
            const code: string = await setRegistrationCode(email);
            const earlier = await pendingRegistrationOf(email);

            expect(await runResendRegistration(email)).toEqual({
                status: 200,
                body: { message: Responses.Authentication.registrationCodeResent }
            });

            expect(await pendingRegistrationOf(email)).toEqual(earlier);
            await verifyRegistration(email, code).expect(201);
        });

        it("should replace the code after the cooldown", async (): Promise<void> => {
            const email: string = testEmailOf(`r${randomHex(5)}`);
            await registerRequest({ email, username: `r${randomHex(5)}`, password }).expect(202);
            const oldCode: string = await setRegistrationCode(email);
            await allowResend(email);

            expect(await runResendRegistration(email.toUpperCase())).toEqual({
                status: 200,
                body: { message: Responses.Authentication.registrationCodeResent }
            });

            expect(await pendingRegistrationOf(email)).toMatchObject({ code: { attempts: 0 } });
            await verifyRegistration(email, oldCode).expect(400);
            await verifyRegistration(email, await setRegistrationCode(email)).expect(201);
        });

        it("should answer a waiting registration like an unknown address and replace its code afterwards", async (): Promise<void> => {
            const email: string = testEmailOf(`r${randomHex(5)}`);
            await registerRequest({ email, username: `r${randomHex(5)}`, password }).expect(202);
            await allowResend(email);
            const earlier = (await pendingRegistrationOf(email)).code;

            const waiting: supertest.Response = await resendRequest({ email });
            const unknown: supertest.Response = await resendRequest({
                email: testEmailOf(`r${randomHex(5)}`)
            });

            expect([waiting.status, waiting.body]).toEqual([unknown.status, unknown.body]);
            expect(waiting.status).toBe(200);
            const replaced = await replacedCodeOf(email, earlier.hash);
            expect(replaced.hash).not.toBe(earlier.hash);
            expect(replaced).toMatchObject({ attempts: 0 });
        });

        it("should not send a code once the account is confirmed", async (): Promise<void> => {
            await resendRequest({ email: user.email }).expect(200);

            expect(await pendingRegistrationOf(user.email)).toBeNull();
        });
    });

    describe("GET /auth/username-available", (): void => {
        it("should answer false for a taken username, whatever its case and spaces", async (): Promise<void> => {
            for (const username of [
                user.username,
                user.username.toUpperCase(),
                `  ${user.username}  `
            ]) {
                const response: supertest.Response = await usernameCheck({ username })
                    .expect("Content-Type", /json/)
                    .expect(200);

                expect(response.body).toEqual({ available: false });
            }
        });

        it("should answer true for a free username", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck({
                username: `u${randomHex(5)}`
            }).expect(200);

            expect(response.body).toEqual({ available: true });
        });

        it("should accept 2 and 16 characters", async (): Promise<void> => {
            const twoCharacters: supertest.Response = await usernameCheck({
                username: randomHex(1)
            }).expect(200);
            expect(typeof twoCharacters.body.available).toBe("boolean");

            const sixteenCharacters: supertest.Response = await usernameCheck({
                username: `u${randomHex(7)}a`
            }).expect(200);
            expect(sixteenCharacters.body).toEqual({ available: true });
        });

        it("should answer 400 for 1 character", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck({ username: "a" }).expect(400);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTooShort });
        });

        it("should answer 400 for 17 characters", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck({
                username: `${randomHex(8)}a`
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTooLong });
        });

        test.each([
            ["only zero-width spaces", "\u200b\u200b"],
            ["a zero-width space", "a\u200b"],
            ["a tab inside", "Rv\tBase"],
            ["only braille blanks", "\u2800\u2800"],
            ["a cantillation mark the collation ignores", "a\u0591"],
            ["presentation selectors after a letter", "ab\ufe0f\ufe0f"]
        ])("should answer 400 for %s", async (_: string, username: string): Promise<void> => {
            const response: supertest.Response = await usernameCheck({ username }).expect(400);

            expect(response.body).toEqual({
                error: Responses.Authentication.usernameInvalidCharacters
            });
        });

        it("should answer 400 for a lone emoji", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck({
                username: "\u{1F600}"
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTooShort });
        });

        it("should answer 400 for only combining marks", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck({
                username: "\u0301\u0301"
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTooShort });
        });

        it("should answer 400 without a username", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck({}).expect(400);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTooShort });
        });

        it("should answer 400 for more than one username", async (): Promise<void> => {
            const response: supertest.Response = await usernameCheck(
                `username=${user.username}&username=u${randomHex(5)}`
            ).expect(400);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTooShort });
        });
    });
});

describe("GitHub OAuth API Tests", (): void => {
    const oauthCookie = (
        state: string,
        mode: string = "login",
        verifier: string = "verifier"
    ): string =>
        `__Host-VB-OAUTH=${encodeURIComponent(`j:${JSON.stringify({ state, verifier, mode })}`)}`;

    const oauthOf = (setCookie: string) =>
        JSON.parse(
            decodeURIComponent(setCookie.split(";")[0].slice("__Host-VB-OAUTH=".length)).slice(2)
        );

    const expectOauthCookie = (setCookie: string): void => {
        expect(setCookie).toMatch(/^__Host-VB-OAUTH=/);
        expect(setCookie).toMatch(/; Path=\/(;|$)/);
        expect(setCookie).toMatch(/; Secure(;|$)/);
        expect(setCookie).toMatch(/; HttpOnly(;|$)/);
        expect(setCookie).toMatch(/; SameSite=Lax(;|$)/);
        expect(setCookie).not.toMatch(/; Domain=/i);
    };

    const startLink = (cookie: string, body: object = {}): supertest.Test =>
        request(TestData.apiURL)
            .post("/auth/github/link")
            .set("Cookie", cookie)
            .set("X-Forwarded-For", isolatedClientIp())
            .send(body);

    const unlink = (cookie: string, body: object = {}): supertest.Test =>
        request(TestData.apiURL)
            .delete("/auth/github/link")
            .set("Cookie", cookie)
            .set("X-Forwarded-For", isolatedClientIp())
            .send(body);

    const stateOf = (response: supertest.Response): string =>
        new URL(response.body.url).searchParams.get("state");

    const storedLinkProof = async (user: TestUser) =>
        (await UserModel.findById(user.id).select("+authentication.githubLink").lean())
            .authentication?.githubLink;

    describeWithGithub("GET /auth/github", (): void => {
        it("should redirect to GitHub with state and a PKCE challenge", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github")
                .expect(302);

            const location: URL = new URL(response.headers.location);
            expect(location.origin + location.pathname).toBe(
                "https://github.com/login/oauth/authorize"
            );
            expect(location.searchParams.get("client_id")).toBeTruthy();
            expect(location.searchParams.get("state")).toBeTruthy();
            expect(location.searchParams.get("code_challenge")).toBeTruthy();
            expect(location.searchParams.get("code_challenge_method")).toBe("S256");
        });

        it("should set a short-lived __Host- OAuth cookie", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github")
                .expect(302);

            expectOauthCookie(response.headers["set-cookie"][0]);
        });
    });

    describe("GET /auth/github/link", (): void => {
        it("should redirect with notLoggedIn when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/link")
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=notLoggedIn$/);
            expect(response.headers["set-cookie"]).toBeUndefined();
        });

        it("should redirect with notLoggedIn with an invalid session cookie", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/link")
                .set("Cookie", `${sessionCookie}=${randomHex(16)}`)
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=notLoggedIn$/);
            expect(response.headers["set-cookie"]).toBeUndefined();
        });

        it("should redirect with passwordRequired for an account with a password", async (): Promise<void> => {
            const passwordUser: TestUser = await createTestUser("lnk");

            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/link")
                .set("Cookie", passwordUser.cookie)
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=passwordRequired$/);
            expect(response.headers["set-cookie"]).toBeUndefined();
        });

        itWithGithub(
            "should redirect a GitHub-only account to GitHub and store a link proof",
            async (): Promise<void> => {
                const githubUser: TestUser = await createTestUser("lnk");
                await linkGithub(githubUser, true);

                const response: supertest.Response = await request(TestData.apiURL)
                    .get("/auth/github/link")
                    .set("Cookie", githubUser.cookie)
                    .expect(302);

                expect(response.headers.location).toMatch(
                    /^https:\/\/github\.com\/login\/oauth\/authorize\?/
                );
                expectOauthCookie(response.headers["set-cookie"][0]);
                expect(await storedLinkProof(githubUser)).toHaveProperty("hash");
            }
        );
    });

    describe("POST /auth/github/link", (): void => {
        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/github/link")
                .send({ password: randomHex(12) })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        itWithGithub.each([
            ["a missing password", {}],
            ["an empty password", { password: "" }],
            ["a non-string password", { password: 12345678 }]
        ])(
            "should return 400 for %s",
            async (description: string, payload: object): Promise<void> => {
                const passwordUser: TestUser = await createTestUser("lnk");

                const response: supertest.Response = await startLink(
                    passwordUser.cookie,
                    payload
                ).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.GithubOauth.missingPassword
                );
                expect(response.headers["set-cookie"]).toBeUndefined();
                expect(await storedLinkProof(passwordUser)).toBeUndefined();
            }
        );

        itWithGithub("should return 403 for a wrong password", async (): Promise<void> => {
            const passwordUser: TestUser = await createTestUser("lnk");

            const response: supertest.Response = await startLink(passwordUser.cookie, {
                password: `${passwordUser.password}x`
            }).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
            expect(response.headers["set-cookie"]).toBeUndefined();
            expect(await storedLinkProof(passwordUser)).toBeUndefined();
        });

        describeWithGithub("with the right password", (): void => {
            let passwordUser: TestUser;
            let response: supertest.Response;

            beforeAll(async (): Promise<void> => {
                passwordUser = await createTestUser("lnk");
                response = await startLink(passwordUser.cookie, {
                    password: passwordUser.password
                });
            });

            it("should answer the GitHub authorize URL with a state", (): void => {
                expect(response.status).toBe(200);

                const url: URL = new URL(response.body.url);
                expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
                expect(url.searchParams.get("state")).toBeTruthy();
                expect(url.searchParams.get("code_challenge_method")).toBe("S256");
            });

            it("should set the OAuth cookie in link mode with the URL's state", (): void => {
                const cookie: string = response.headers["set-cookie"][0];
                expectOauthCookie(cookie);

                const oauth = oauthOf(cookie);
                expect(oauth).toHaveProperty("mode", "link");
                expect(oauth).toHaveProperty("state", stateOf(response));
            });

            it("should store a link proof that expires within 10 minutes", async (): Promise<void> => {
                const proof = await storedLinkProof(passwordUser);

                expect(proof).toHaveProperty("hash");
                expect(proof.expiresAt.getTime()).toBeGreaterThan(Date.now());
                expect(proof.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
            });
        });

        itWithGithub(
            "should answer the authorize URL and store a link proof for a GitHub-only account without a password",
            async (): Promise<void> => {
                const githubUser: TestUser = await createTestUser("lnk");
                await linkGithub(githubUser, true);

                const response: supertest.Response = await startLink(githubUser.cookie).expect(200);

                expect(stateOf(response)).toBeTruthy();
                expectOauthCookie(response.headers["set-cookie"][0]);
                expect(await storedLinkProof(githubUser)).toHaveProperty("hash");
            }
        );
    });

    describe("DELETE /auth/github/link", (): void => {
        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/auth/github/link")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should return 404 when no GitHub account is linked", async (): Promise<void> => {
            const unlinkedUser: TestUser = await createTestUser("unl");

            const response: supertest.Response = await unlink(unlinkedUser.cookie, {
                password: unlinkedUser.password
            }).expect(404);

            expect(response.body).toHaveProperty("error", Responses.GithubOauth.githubNotLinked);
        });

        test.each([
            ["a missing password", {}, 400, Responses.GithubOauth.missingPassword],
            ["an empty password", { password: "" }, 400, Responses.GithubOauth.missingPassword],
            [
                "a non-string password",
                { password: 12345678 },
                400,
                Responses.GithubOauth.missingPassword
            ],
            [
                "a wrong password",
                { password: randomHex(12) },
                403,
                Responses.Authentication.incorrectPassword
            ]
        ])(
            "should return the error and keep GitHub linked for %s",
            async (
                description: string,
                payload: object,
                status: number,
                error: string
            ): Promise<void> => {
                const linkedUser: TestUser = await createTestUser("unl");
                const githubId: string = await linkGithub(linkedUser);

                const response: supertest.Response = await unlink(
                    linkedUser.cookie,
                    payload
                ).expect(status);

                expect(response.body).toHaveProperty("error", error);
                expect(await UserModel.findById(linkedUser.id).lean()).toHaveProperty(
                    "githubId",
                    githubId
                );
            }
        );

        it("should unlink GitHub from an account with the right password", async (): Promise<void> => {
            const linkedUser: TestUser = await createTestUser("unl");
            await linkGithub(linkedUser);

            const response: supertest.Response = await unlink(linkedUser.cookie, {
                password: linkedUser.password
            }).expect(200);

            expect(response.body).toHaveProperty(
                "message",
                Responses.GithubOauth.githubUnlinkedSuccess
            );

            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", linkedUser.cookie)
                .expect(200);

            expect(userResponse.body).not.toHaveProperty("githubId");
            expect(userResponse.body).not.toHaveProperty("githubLogin");

            const storedUser = await UserModel.findById(linkedUser.id).lean();
            expect(Object.keys(storedUser)).not.toContain("githubId");
            expect(Object.keys(storedUser)).not.toContain("githubLogin");
        });

        it("should return 403 when GitHub is the account's only login", async (): Promise<void> => {
            const githubUser: TestUser = await createTestUser("unl");
            const githubId: string = await linkGithub(githubUser, true);

            const response: supertest.Response = await unlink(githubUser.cookie).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.GithubOauth.cannotUnlinkWithoutPassword
            );
            expect(await UserModel.findById(githubUser.id).lean()).toHaveProperty(
                "githubId",
                githubId
            );
        });
    });

    describe("POST /user/password", (): void => {
        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/user/password")
                .send({ password: randomHex(12) })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        test.each([
            ["a missing password", {}],
            ["an empty password", { password: "" }],
            ["a non-string password", { password: 12345678 }]
        ])(
            "should return 400 for %s",
            async (description: string, payload: object): Promise<void> => {
                const githubUser: TestUser = await createTestUser("setpw");
                await linkGithub(githubUser, true);

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/user/password")
                    .set("Cookie", githubUser.cookie)
                    .send(payload)
                    .expect(400);

                expect(response.body).toHaveProperty("error", Responses.Users.missingPassword);
            }
        );

        test.each([
            [7, Responses.Authentication.passwordTooShort],
            [129, Responses.Authentication.passwordTooLong]
        ])(
            "should return 400 and leave the password unset for a %i character password",
            async (length: number, error: string): Promise<void> => {
                const githubUser: TestUser = await createTestUser("setpw");
                await linkGithub(githubUser, true);

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/user/password")
                    .set("Cookie", githubUser.cookie)
                    .send({ password: generateRandomString(length) })
                    .expect(400);

                expect(response.body).toHaveProperty("error", error);

                const userResponse: supertest.Response = await request(TestData.apiURL)
                    .get("/user")
                    .set("Cookie", githubUser.cookie)
                    .expect(200);

                expect(userResponse.body).toHaveProperty("hasPassword", false);
            }
        );

        it("should set an 8 character password", async (): Promise<void> => {
            const githubUser: TestUser = await createTestUser("setpw");
            await linkGithub(githubUser, true);
            await confirmGithub(githubUser);
            const password: string = generateRandomString(8);

            await request(TestData.apiURL)
                .post("/user/password")
                .set("Cookie", githubUser.cookie)
                .send({ password })
                .expect(200);

            await login(githubUser.email, password);
        });

        it("should return 409 when the account already has a password", async (): Promise<void> => {
            const passwordUser: TestUser = await createTestUser("setpw");

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/user/password")
                .set("Cookie", passwordUser.cookie)
                .send({ password: randomHex(12) })
                .expect(409);

            expect(response.body).toHaveProperty("error", Responses.Users.passwordAlreadySet);
            await login(passwordUser.email, passwordUser.password);
        });

        test.each([
            ["without a GitHub confirmation", undefined],
            ["with a GitHub confirmation older than 10 minutes", 11],
            ["with a GitHub confirmation in the future", -5]
        ])(
            "should return 403 and leave the password unset %s",
            async (description: string, minutesAgo: number | undefined): Promise<void> => {
                const githubUser: TestUser = await createTestUser("setpw");
                await linkGithub(githubUser, true);
                if (minutesAgo !== undefined) {
                    await confirmGithub(githubUser, new Date(Date.now() - minutesAgo * 60 * 1000));
                }

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/user/password")
                    .set("Cookie", githubUser.cookie)
                    .send({ password: randomHex(12) })
                    .expect(403);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Users.githubReauthRequired(10)
                );

                const userResponse: supertest.Response = await request(TestData.apiURL)
                    .get("/user")
                    .set("Cookie", githubUser.cookie)
                    .expect(200);

                expect(userResponse.body).toHaveProperty("hasPassword", false);
            }
        );

        it("should not set a password with a session that ended after the GitHub confirmation", async (): Promise<void> => {
            const githubUser: TestUser = await createTestUser("setpw");
            await linkGithub(githubUser, true);
            await confirmGithub(githubUser);
            await storeSession(githubUser);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/user/password")
                .set("Cookie", githubUser.cookie)
                .send({ password: randomHex(12) })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);

            const storedUser = await UserModel.findById(githubUser.id)
                .select("+authentication.password")
                .lean();
            expect(storedUser.authentication).not.toHaveProperty("password");
        });

        it("should let only one of several concurrent calls set the password", async (): Promise<void> => {
            const githubUser: TestUser = await createTestUser("setpw");
            await linkGithub(githubUser, true);
            await confirmGithub(githubUser);
            const passwords: string[] = Array.from({ length: 5 }, (): string => randomHex(12));

            const responses: supertest.Response[] = await Promise.all(
                passwords.map((password: string): Promise<supertest.Response> =>
                    request(TestData.apiURL)
                        .post("/user/password")
                        .set("Cookie", githubUser.cookie)
                        .send({ password })
                )
            );

            const statuses: number[] = responses.map(
                (response: supertest.Response): number => response.status
            );
            expect(statuses.filter((status: number): boolean => status === 200)).toHaveLength(1);
            for (const response of responses.filter(
                (response: supertest.Response): boolean => response.status !== 200
            )) {
                expect([403, 409]).toContain(response.status);
                expect(response.body).toHaveProperty(
                    "error",
                    response.status === 403
                        ? Responses.notLoggedIn
                        : Responses.Users.passwordAlreadySet
                );
            }

            const winner: string = passwords[statuses.indexOf(200)];
            for (const password of passwords) {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/login")
                    .send({ email: githubUser.email, password });

                expect(response.status).toBe(password === winner ? 200 : 403);
            }
        });

        describe("on a GitHub-only account confirmed with GitHub", (): void => {
            let githubUser: TestUser;
            let setResponse: supertest.Response;
            const password: string = randomHex(12);

            beforeAll(async (): Promise<void> => {
                githubUser = await createTestUser("setpw");
                await linkGithub(githubUser, true);
                await confirmGithub(githubUser);

                setResponse = await request(TestData.apiURL)
                    .post("/user/password")
                    .set("Cookie", githubUser.cookie)
                    .send({ password });
            });

            it("should set the password", (): void => {
                expect(setResponse.status).toBe(200);
                expect(setResponse.body).toHaveProperty(
                    "message",
                    Responses.Users.passwordSetSuccess
                );
            });

            it("should store the password as a scrypt hash", async (): Promise<void> => {
                expect((await storedAuthentication(githubUser.id)).password).toMatch(
                    scryptHashPattern
                );
            });

            it("should use up the GitHub confirmation", async (): Promise<void> => {
                const storedUser = await UserModel.findById(githubUser.id)
                    .select("+authentication.githubVerifiedAt")
                    .lean();

                expect(storedUser.authentication).not.toHaveProperty("githubVerifiedAt");
            });

            it("should end the old session", async (): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .get("/user")
                    .set("Cookie", githubUser.cookie)
                    .expect(403);

                expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
            });

            it("should set a new session cookie that works", async (): Promise<void> => {
                const cookie: string = setResponse.headers["set-cookie"][0];
                expect(cookie).toMatch(new RegExp(`^${sessionCookie}=`));
                expect(cookie).not.toBe(githubUser.cookie);

                const response: supertest.Response = await request(TestData.apiURL)
                    .get("/user")
                    .set("Cookie", cookie)
                    .expect(200);

                expect(response.body).toHaveProperty("_id", githubUser.id);
                expect(response.body).toHaveProperty("hasPassword", true);
            });

            it("should log in with the new password, unlink GitHub and refuse a second set", async (): Promise<void> => {
                const cookie: string = await login(githubUser.email, password);

                await unlink(cookie, { password }).expect(200);

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/user/password")
                    .set("Cookie", cookie)
                    .send({ password: randomHex(12) })
                    .expect(409);

                expect(response.body).toHaveProperty("error", Responses.Users.passwordAlreadySet);
            });
        });
    });

    describe("PATCH /user/password", (): void => {
        const changePassword = (cookie: string, body: object): supertest.Test =>
            request(TestData.apiURL).patch("/user/password").set("Cookie", cookie).send(body);

        let changedUser: TestUser;
        let changeResponse: supertest.Response;
        let invalidUser: TestUser;
        let githubOnlyUser: TestUser;
        let linkedUser: TestUser;
        let linkedGithubId: string;

        const newPassword: string = randomHex(12);

        beforeAll(async (): Promise<void> => {
            [changedUser, invalidUser, githubOnlyUser, linkedUser] = await Promise.all([
                createTestUser("chpw"),
                createTestUser("chpw"),
                createTestUser("chpw"),
                createTestUser("chpw")
            ]);

            await linkGithub(githubOnlyUser, true);
            linkedGithubId = await linkGithub(linkedUser);

            changeResponse = await changePassword(changedUser.cookie, {
                currentPassword: changedUser.password,
                newPassword
            });
        });

        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch("/user/password")
                .send({ currentPassword: randomHex(12), newPassword })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should change the password", (): void => {
            expect(changeResponse.status).toBe(200);
            expect(changeResponse.body).toHaveProperty(
                "message",
                Responses.Users.passwordChangedSuccess
            );
        });

        it("should store the new password as a scrypt hash", async (): Promise<void> => {
            expect((await storedAuthentication(changedUser.id)).password).toMatch(
                scryptHashPattern
            );
        });

        it("should end the old session", async (): Promise<void> => {
            await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", changedUser.cookie)
                .expect(403);
        });

        it("should set a new session cookie that works", async (): Promise<void> => {
            const cookie: string = changeResponse.headers["set-cookie"][0];
            expect(cookie).toMatch(new RegExp(`^${sessionCookie}=`));
            expect(cookie).not.toBe(changedUser.cookie);

            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            expect(response.body).toHaveProperty("_id", changedUser.id);
        });

        it("should refuse the old password on login", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: changedUser.email, password: changedUser.password })
                .expect(403);

            expect(response.body).toEqual({ error: Responses.Authentication.invalidCredentials });
        });

        it("should log in with the new password", async (): Promise<void> => {
            await login(changedUser.email, newPassword);
        });

        it("should return 403 when the current password is wrong", async (): Promise<void> => {
            const response: supertest.Response = await changePassword(invalidUser.cookie, {
                currentPassword: `${invalidUser.password}x`,
                newPassword
            }).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
            await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", invalidUser.cookie)
                .expect(200);
        });

        test.each([
            ["a missing current password", { newPassword }],
            ["a missing new password", { currentPassword: randomHex(12) }],
            ["a non-string current password", { currentPassword: 12345678, newPassword }],
            [
                "a non-string new password",
                { currentPassword: randomHex(12), newPassword: [newPassword] }
            ]
        ])(
            "should return 400 for %s",
            async (description: string, payload: object): Promise<void> => {
                const response: supertest.Response = await changePassword(
                    invalidUser.cookie,
                    payload
                ).expect(400);

                expect(response.body).toHaveProperty("error", Responses.Users.missingPasswords);
            }
        );

        test.each([
            [7, Responses.Authentication.passwordTooShort],
            [129, Responses.Authentication.passwordTooLong]
        ])(
            "should return 400 for a %i character new password",
            async (length: number, error: string): Promise<void> => {
                const response: supertest.Response = await changePassword(invalidUser.cookie, {
                    currentPassword: invalidUser.password,
                    newPassword: generateRandomString(length)
                }).expect(400);

                expect(response.body).toHaveProperty("error", error);
            }
        );

        it("should return 409 when the account has no password", async (): Promise<void> => {
            const response: supertest.Response = await changePassword(githubOnlyUser.cookie, {
                currentPassword: githubOnlyUser.password,
                newPassword
            }).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Users.noPasswordToChange);
        });

        it("should keep GitHub linked after a change", async (): Promise<void> => {
            const { githubLogin } = await UserModel.findById(linkedUser.id).lean();

            await changePassword(linkedUser.cookie, {
                currentPassword: linkedUser.password,
                newPassword
            }).expect(200);

            const storedUser = await UserModel.findById(linkedUser.id).lean();
            expect(storedUser).toHaveProperty("githubId", linkedGithubId);
            expect(storedUser).toHaveProperty("githubLogin", githubLogin);
        });
    });

    describe("GET /auth/github/callback", (): void => {
        interface UserLink {
            state: string;
            verifier: string;
            oauth: string;
        }

        const linkCallback = (
            cookie: string,
            state: string,
            oauth: string = oauthCookie(state, "link")
        ): supertest.Test =>
            request(TestData.apiURL)
                .get(`/auth/github/callback?code=invalid&state=${encodeURIComponent(state)}`)
                .set("Cookie", `${cookie.split(";")[0]}; ${oauth}`);

        const expectInvalidState = (response: supertest.Response): void => {
            expect(response.status).toBe(302);
            expect(response.headers.location).toMatch(/\/account\?oauthError=invalidState$/);
        };

        const startUserLink = async (
            user: TestUser,
            body: object = { password: user.password }
        ): Promise<UserLink> => {
            const response: supertest.Response = await startLink(user.cookie, body).expect(200);

            const setCookie: string = response.headers["set-cookie"][0];

            return {
                state: stateOf(response),
                verifier: oauthOf(setCookie).verifier,
                oauth: setCookie.split(";")[0]
            };
        };

        it("should redirect with invalidState without an OAuth cookie", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?code=foo&state=bar")
                .expect(302);

            expect(response.headers.location).toMatch(/\/login\?oauthError=invalidState$/);
        });

        it("should redirect with invalidState when the state doesn't match", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?code=foo&state=bar")
                .set("Cookie", oauthCookie("baz"))
                .expect(302);

            expect(response.headers.location).toMatch(/\/login\?oauthError=invalidState$/);
        });

        it("should clear the OAuth cookie with the attributes it was set with", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?code=foo&state=bar")
                .set("Cookie", oauthCookie("baz"))
                .expect(302);

            const cleared: string = response.headers["set-cookie"][0];
            expect(cleared).toMatch(/^__Host-VB-OAUTH=;/);
            expect(cleared).toMatch(/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(;|$)/);
            expectOauthCookie(cleared);
        });

        it("should redirect with accessDenied when the user cancels on GitHub", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?error=access_denied&state=bar")
                .set("Cookie", oauthCookie("bar"))
                .expect(302);

            expect(response.headers.location).toMatch(/\/login\?oauthError=accessDenied$/);
        });

        it("should redirect with githubError when GitHub rejects the code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?code=invalid&state=bar")
                .set("Cookie", oauthCookie("bar"))
                .expect(302);

            expect(response.headers.location).toMatch(/\/login\?oauthError=githubError$/);
        });

        it("should redirect link errors to /account when the user cancels on GitHub", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?error=access_denied&state=bar")
                .set("Cookie", oauthCookie("bar", "link"))
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=accessDenied$/);
        });

        itWithGithub(
            "should redirect link errors to /account when GitHub rejects the code",
            async (): Promise<void> => {
                const githubUser: TestUser = await createTestUser("cb");
                await linkGithub(githubUser, true);
                const { state, oauth } = await startUserLink(githubUser, {});

                const response: supertest.Response = await linkCallback(
                    githubUser.cookie,
                    state,
                    oauth
                ).expect(302);

                expect(response.headers.location).toMatch(/\/account\?oauthError=githubError$/);
            }
        );

        it("should redirect a link without a session with notLoggedIn before exchanging the code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?code=invalid&state=bar")
                .set("Cookie", oauthCookie("bar", "link"))
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=notLoggedIn$/);
        });

        describe("in link mode for an account with a password", (): void => {
            it("should redirect with invalidState for a forged OAuth cookie without a link proof", async (): Promise<void> => {
                const passwordUser: TestUser = await createTestUser("cb");

                expectInvalidState(await linkCallback(passwordUser.cookie, randomHex(16)));
            });

            itWithGithub(
                "should redirect with invalidState when the link proof is for another state",
                async (): Promise<void> => {
                    const passwordUser: TestUser = await createTestUser("cb");
                    const { verifier } = await startUserLink(passwordUser);
                    const otherState: string = randomHex(16);

                    expectInvalidState(
                        await linkCallback(
                            passwordUser.cookie,
                            otherState,
                            oauthCookie(otherState, "link", verifier)
                        )
                    );
                }
            );

            itWithGithub(
                "should redirect with invalidState for a forged OAuth cookie with the proof's state but another verifier",
                async (): Promise<void> => {
                    const passwordUser: TestUser = await createTestUser("cb");
                    const { state } = await startUserLink(passwordUser);

                    expectInvalidState(await linkCallback(passwordUser.cookie, state));
                    expect(await storedLinkProof(passwordUser)).toBeDefined();
                }
            );

            itWithGithub(
                "should redirect with invalidState when the link proof is for another session",
                async (): Promise<void> => {
                    const passwordUser: TestUser = await createTestUser("cb");
                    const { state, oauth } = await startUserLink(passwordUser);
                    const newCookie: string = await login(
                        passwordUser.email,
                        passwordUser.password
                    );

                    expectInvalidState(await linkCallback(newCookie, state, oauth));
                }
            );

            itWithGithub(
                "should redirect with invalidState for an OAuth cookie started by another user's session",
                async (): Promise<void> => {
                    const [passwordUser, otherUser]: TestUser[] = await Promise.all([
                        createTestUser("cb"),
                        createTestUser("cb")
                    ]);
                    const { state, oauth } = await startUserLink(otherUser);

                    expectInvalidState(await linkCallback(passwordUser.cookie, state, oauth));
                    expect(await storedLinkProof(otherUser)).toHaveProperty("hash");
                }
            );

            itWithGithub(
                "should redirect with invalidState when the link proof has expired",
                async (): Promise<void> => {
                    const passwordUser: TestUser = await createTestUser("cb");
                    const { state, oauth } = await startUserLink(passwordUser);
                    await UserModel.updateOne(
                        { _id: passwordUser.id },
                        {
                            $set: {
                                "authentication.githubLink.expiresAt": new Date(Date.now() - 1000)
                            }
                        }
                    );

                    expectInvalidState(await linkCallback(passwordUser.cookie, state, oauth));
                }
            );

            itWithGithub(
                "should redirect with invalidState when a second link replaced the proof",
                async (): Promise<void> => {
                    const passwordUser: TestUser = await createTestUser("cb");
                    const { state, oauth } = await startUserLink(passwordUser);
                    await startUserLink(passwordUser);

                    expectInvalidState(await linkCallback(passwordUser.cookie, state, oauth));
                }
            );

            itWithGithub(
                "should reach the code exchange (githubError) with a valid link proof and then refuse its replay with invalidState",
                async (): Promise<void> => {
                    const passwordUser: TestUser = await createTestUser("cb");
                    const { state, oauth } = await startUserLink(passwordUser);

                    const response: supertest.Response = await linkCallback(
                        passwordUser.cookie,
                        state,
                        oauth
                    ).expect(302);

                    expect(response.headers.location).toMatch(/\/account\?oauthError=githubError$/);
                    expect(await storedLinkProof(passwordUser)).toBeUndefined();

                    expectInvalidState(await linkCallback(passwordUser.cookie, state, oauth));
                }
            );
        });

        describe("in link mode for an account without a password", (): void => {
            const createGithubUser = async (): Promise<TestUser> => {
                const githubUser: TestUser = await createTestUser("cbg");
                await linkGithub(githubUser, true);
                return githubUser;
            };

            it("should redirect with invalidState for an OAuth cookie its session didn't start", async (): Promise<void> => {
                const githubUser: TestUser = await createGithubUser();

                expectInvalidState(await linkCallback(githubUser.cookie, randomHex(16)));
            });

            itWithGithub(
                "should redirect with invalidState for an OAuth cookie started by another user's session",
                async (): Promise<void> => {
                    const [githubUser, otherUser]: TestUser[] = await Promise.all([
                        createGithubUser(),
                        createGithubUser()
                    ]);
                    const { state, oauth } = await startUserLink(otherUser, {});

                    expectInvalidState(await linkCallback(githubUser.cookie, state, oauth));
                    expect(await storedLinkProof(otherUser)).toHaveProperty("hash");
                }
            );

            itWithGithub(
                "should redirect with invalidState for an OAuth cookie started by its own earlier session",
                async (): Promise<void> => {
                    const githubUser: TestUser = await createGithubUser();
                    const { state, oauth } = await startUserLink(githubUser, {});

                    expectInvalidState(
                        await linkCallback(await storeSession(githubUser), state, oauth)
                    );
                }
            );

            itWithGithub(
                "should reach the code exchange (githubError) with its own link start and then refuse its replay with invalidState",
                async (): Promise<void> => {
                    const githubUser: TestUser = await createGithubUser();
                    const { state, oauth } = await startUserLink(githubUser, {});

                    const response: supertest.Response = await linkCallback(
                        githubUser.cookie,
                        state,
                        oauth
                    ).expect(302);

                    expect(response.headers.location).toMatch(/\/account\?oauthError=githubError$/);
                    expect(await storedLinkProof(githubUser)).toBeUndefined();

                    expectInvalidState(await linkCallback(githubUser.cookie, state, oauth));
                }
            );
        });
    });
});
