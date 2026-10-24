import request from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { generateRandomString } from "../helpers/text";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";
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

        it("should not let the user register with an existing username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = user.username;

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
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

        it("should not let the user register with a too long (16+ char) username", async (): Promise<void> => {
            testEmail = testEmailOf(generateRandomString(8));
            testUsername = "0123456789abcdefg";

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTooLong);
        });

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
        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/auth/github/link")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });
    });

    describe("DELETE /auth/github/link", (): void => {
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

        beforeAll(async (): Promise<void> => {
            await mongoose.connect(process.env.DB_CONNECTION_STRING, {
                autoCreate: false,
                autoIndex: false
            });
        });

        afterAll(async (): Promise<void> => {
            await mongoose.disconnect();
        });

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
