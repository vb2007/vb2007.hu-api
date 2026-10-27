import request from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { authentication, random } from "../helpers";
import { generateRandomString } from "../helpers/text";
import { TestUser, createTestUser, login, randomHex, testEmailOf } from "./helpers/testUsers";
import supertest from "supertest";

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

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
        });

        it("should return 404 when there is no such user in the database", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: "foo", password: "foo" })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.Authentication.userNotFound);
        });

        it("should set session cookie with correct attributes", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: user.password })
                .expect(200);

            const cookie: string = response.headers["set-cookie"][0];
            expect(cookie).toMatch(/VB-AUTH/);
            expect(cookie).toMatch(/Path=\//);
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

                await mongoose.connect(process.env.DB_CONNECTION_STRING, {
                    autoCreate: false,
                    autoIndex: false
                });

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

            afterAll(async (): Promise<void> => {
                await mongoose.disconnect();
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
            expect(cookie).toMatch(/^VB-AUTH=;/);
            expect(cookie).toMatch(/Path=\//);

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

        it("should register a new user successfully", async (): Promise<void> => {
            testUsername = `t${generateRandomString(10)}`;
            testEmail = testEmailOf(testUsername);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(201);

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(testUsername)
            );
        });

        it("should not let the user register with an existing email", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({
                    email: user.email,
                    password: testPassword,
                    username: generateRandomString(8)
                })
                .expect(409);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.emailAlreadyExists
            );
        });

        test.each([
            ["an existing e-mail", (): string => user.email],
            ["SUPERUSER_EMAIL", (): string => TestData.superuser.email]
        ])(
            "should not let the user register an upper-case copy of %s",
            async (description: string, existingEmail: () => string): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/register")
                    .send({
                        email: ` ${existingEmail().toUpperCase()} `,
                        password: testPassword,
                        username: `t${generateRandomString(10)}`
                    })
                    .expect(409);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.emailAlreadyExists
                );
            }
        );

        it("should store the e-mail lower-cased", async (): Promise<void> => {
            const username: string = `t${generateRandomString(10)}`;
            const email: string = testEmailOf(username);

            await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: email.toUpperCase(), password: testPassword, username })
                .expect(201);

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

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
        });

        it("should not let the user register with a whitespace-padded existing username", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({
                    email: testEmailOf(`t${generateRandomString(10)}`),
                    password: testPassword,
                    username: ` ${user.username} `
                })
                .expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
        });

        it("should not let the user register with a too short (2- char) username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = "a";

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.usernameTooShort
            );
        });

        it("should not let the user register with a whitespace-padded too short username", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({
                    email: testEmailOf(`t${generateRandomString(10)}`),
                    password: testPassword,
                    username: "  a  "
                })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.usernameTooShort
            );
        });

        it("should not let the user register with a too long (16+ char) username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = "0123456789abcdefg";

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTooLong);
        });

        test.each([
            [7, Responses.Authentication.passwordTooShort],
            [129, Responses.Authentication.passwordTooLong]
        ])(
            "should not let the user register with a %i character password",
            async (length: number, error: string): Promise<void> => {
                const username: string = `pw${randomHex(5)}`;

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/register")
                    .send({
                        email: testEmailOf(username),
                        password: generateRandomString(length),
                        username
                    })
                    .expect(400);

                expect(response.body).toHaveProperty("error", error);
            }
        );

        it("should not let the user register with a 4 emoji password", async (): Promise<void> => {
            const username: string = `pw${randomHex(5)}`;

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmailOf(username), password: "\u{1F600}".repeat(4), username })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.passwordTooShort
            );
        });

        it("should register a user with a 65 emoji password", async (): Promise<void> => {
            const username: string = `pw${randomHex(5)}`;
            const email: string = testEmailOf(username);
            const password: string = "\u{1F600}".repeat(65);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email, password, username })
                .expect(201);

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

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/register")
                    .send({ email, password, username })
                    .expect(201);

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

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.invalidEmailFormat
            );
        });

        it("should not let the user register without a request body", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .expect(400);

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

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/register")
                    .send(payload);

                expect(response.status).toBe(400);
            }
        );
    });
});

describe("GitHub OAuth API Tests", (): void => {
    const oauthCookie = (state: string, mode: string = "login"): string =>
        `VB-OAUTH=${encodeURIComponent(`j:${JSON.stringify({ state, verifier: "verifier", mode })}`)}`;

    const linkGithub = async (
        linkedUser: TestUser,
        withoutPassword: boolean = false
    ): Promise<string> => {
        const githubId: string = `${TestData.runId}-${randomHex(8)}`;

        await UserModel.updateOne(
            { _id: linkedUser.id },
            {
                $set: { githubId, githubLogin: `gh-${randomHex(5)}` },
                ...(withoutPassword && {
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                })
            }
        );

        return githubId;
    };

    const confirmGithub = async (
        githubUser: TestUser,
        verifiedAt: Date = new Date()
    ): Promise<void> => {
        await UserModel.updateOne(
            { _id: githubUser.id },
            { $set: { "authentication.githubVerifiedAt": verifiedAt } }
        );
    };

    beforeAll(async (): Promise<void> => {
        await mongoose.connect(process.env.DB_CONNECTION_STRING, {
            autoCreate: false,
            autoIndex: false
        });
    });

    afterAll(async (): Promise<void> => {
        await mongoose.disconnect();
    });

    describe("GET /auth/github", (): void => {
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

        it("should set a short-lived OAuth cookie", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github")
                .expect(302);

            const cookie: string = response.headers["set-cookie"][0];
            expect(cookie).toMatch(/^VB-OAUTH=/);
            expect(cookie).toMatch(/Path=\/auth\/github/);
            expect(cookie).toMatch(/HttpOnly/);
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
                .set("Cookie", `VB-AUTH=${randomHex(16)}`)
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=notLoggedIn$/);
            expect(response.headers["set-cookie"]).toBeUndefined();
        });

        it("should not redirect with notLoggedIn when logged in", async (): Promise<void> => {
            const linkingUser: TestUser = await createTestUser("lnk");

            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/link")
                .set("Cookie", linkingUser.cookie)
                .expect(302);

            expect(response.headers.location).toMatch(
                /^https:\/\/github\.com\/login\/oauth\/authorize\?|\/account\?oauthError=notConfigured$/
            );
        });
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

            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/auth/github/link")
                .set("Cookie", unlinkedUser.cookie)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.GithubOauth.githubNotLinked);
        });

        it("should unlink GitHub from an account with a password", async (): Promise<void> => {
            const linkedUser: TestUser = await createTestUser("unl");
            await linkGithub(linkedUser);

            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/auth/github/link")
                .set("Cookie", linkedUser.cookie)
                .expect(200);

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

            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/auth/github/link")
                .set("Cookie", githubUser.cookie)
                .expect(403);

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
            ["with a GitHub confirmation older than 10 minutes", 11]
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
            for (const status of statuses.filter((status: number): boolean => status !== 200)) {
                expect([403, 409]).toContain(status);
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
                expect(cookie).toMatch(/^VB-AUTH=/);
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

                await request(TestData.apiURL)
                    .delete("/auth/github/link")
                    .set("Cookie", cookie)
                    .expect(200);

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
        }, 25000);

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

        it("should end the old session", async (): Promise<void> => {
            await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", changedUser.cookie)
                .expect(403);
        });

        it("should set a new session cookie that works", async (): Promise<void> => {
            const cookie: string = changeResponse.headers["set-cookie"][0];
            expect(cookie).toMatch(/^VB-AUTH=/);
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

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
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

        it("should redirect link errors to /account when GitHub rejects the code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/callback?code=invalid&state=bar")
                .set("Cookie", oauthCookie("bar", "link"))
                .expect(302);

            expect(response.headers.location).toMatch(/\/account\?oauthError=githubError$/);
        });
    });
});
