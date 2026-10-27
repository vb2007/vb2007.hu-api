import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, isSuperuserEmail } from "../helpers";
import { TestUser, createTestUser, login, randomHex } from "./helpers/testUsers";

describe("Users API Tests", (): void => {
    describe("GET /user", (): void => {
        let other: TestUser;
        let passwordUser: TestUser;
        let githubUser: TestUser;

        const githubLogin: string = `gh-${randomHex(5)}`;

        beforeAll(async (): Promise<void> => {
            other = await createTestUser();
            passwordUser = await createTestUser();
            githubUser = await createTestUser("gh");

            await mongoose.connect(process.env.DB_CONNECTION_STRING, {
                autoCreate: false,
                autoIndex: false
            });

            await UserModel.updateOne(
                { _id: githubUser.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin },
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                }
            );
        }, 25000);

        afterAll(async (): Promise<void> => {
            await mongoose.disconnect();
        });

        it("should mark the superuser as isSuperuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", TestData.superuser.email);
            expect(response.body).toHaveProperty("isSuperuser", true);
        });

        it("should not mark another user as isSuperuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", other.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", other.email);
            expect(response.body).toHaveProperty("isSuperuser", false);
        });

        it("should return hasPassword without the credentials for a password user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", passwordUser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("hasPassword", true);
            expect(response.body).not.toHaveProperty("authentication");
        });

        it("should return githubLogin and no password for a GitHub-only user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", githubUser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("username", githubUser.username);
            expect(response.body).toHaveProperty("githubLogin", githubLogin);
            expect(response.body).toHaveProperty("hasPassword", false);
            expect(response.body).not.toHaveProperty("authentication");
        });
    });

    describe("GET /users", (): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser();
        }, 25000);

        it("should not list users to a logged-in user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/users")
                .set("Cookie", user.cookie)
                .expect(302);

            expect(response.headers.location).toContain("/apierror");
            expect(response.text).not.toContain(user.email);
            expect(response.text).not.toContain(TestData.superuser.email);
            expect(Array.isArray(response.body)).toBe(false);
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

        const newPassword: string = randomHex(12);
        const linkedGithubId: string = `${TestData.runId}-${randomHex(8)}`;

        beforeAll(async (): Promise<void> => {
            changedUser = await createTestUser("cpw");
            invalidUser = await createTestUser("cpw");
            githubOnlyUser = await createTestUser("cpwgh");
            linkedUser = await createTestUser("cpwln");

            await mongoose.connect(process.env.DB_CONNECTION_STRING, {
                autoCreate: false,
                autoIndex: false
            });

            await UserModel.updateOne(
                { _id: githubOnlyUser.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}` },
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                }
            );
            await UserModel.updateOne(
                { _id: linkedUser.id },
                { $set: { githubId: linkedGithubId, githubLogin: `gh-${randomHex(5)}` } }
            );

            changeResponse = await changePassword(changedUser.cookie, {
                currentPassword: changedUser.password,
                newPassword
            });
        }, 25000);

        afterAll(async (): Promise<void> => {
            await mongoose.disconnect();
        });

        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch("/user/password")
                .send({ currentPassword: "whatever-old", newPassword })
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
            await expect(login(changedUser.email, newPassword)).resolves.toMatch(/^VB-AUTH=/);
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

        it.each([
            ["the current password is missing", { newPassword }],
            ["the new password is missing", { currentPassword: "whatever-old" }],
            ["the current password isn't a string", { currentPassword: 12345678, newPassword }],
            [
                "the new password isn't a string",
                { currentPassword: "whatever-old", newPassword: [newPassword] }
            ]
        ])("should return 400 when %s", async (_: string, body: object): Promise<void> => {
            const response: supertest.Response = await changePassword(
                invalidUser.cookie,
                body
            ).expect(400);

            expect(response.body).toHaveProperty("error", Responses.Users.missingPasswords);
        });

        it.each([
            [
                "short",
                "a".repeat(PASSWORD_MIN_LENGTH - 1),
                Responses.Authentication.passwordTooShort
            ],
            ["long", "a".repeat(PASSWORD_MAX_LENGTH + 1), Responses.Authentication.passwordTooLong]
        ])(
            "should return 400 when the new password is too %s",
            async (_: string, password: string, error: string): Promise<void> => {
                const response: supertest.Response = await changePassword(invalidUser.cookie, {
                    currentPassword: invalidUser.password,
                    newPassword: password
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
            await changePassword(linkedUser.cookie, {
                currentPassword: linkedUser.password,
                newPassword
            }).expect(200);

            expect(await UserModel.findById(linkedUser.id).lean()).toHaveProperty(
                "githubId",
                linkedGithubId
            );
        });
    });

    describe("isSuperuserEmail", (): void => {
        const originalSuperuserEmail: string | undefined = process.env.SUPERUSER_EMAIL;

        afterEach((): void => {
            if (originalSuperuserEmail === undefined) {
                delete process.env.SUPERUSER_EMAIL;
            } else {
                process.env.SUPERUSER_EMAIL = originalSuperuserEmail;
            }
        });

        it("should match the configured e-mail", (): void => {
            process.env.SUPERUSER_EMAIL = "admin@example.com";

            expect(isSuperuserEmail("admin@example.com")).toBe(true);
            expect(isSuperuserEmail("other@example.com")).toBe(false);
        });

        it("should ignore case", (): void => {
            process.env.SUPERUSER_EMAIL = "Admin@Example.com";

            expect(isSuperuserEmail("aDMIN@example.COM")).toBe(true);
        });

        it("should ignore surrounding whitespace", (): void => {
            process.env.SUPERUSER_EMAIL = "  admin@example.com\t";

            expect(isSuperuserEmail(" admin@example.com  ")).toBe(true);
        });

        it("should match nobody when the env is empty", (): void => {
            process.env.SUPERUSER_EMAIL = "  ";

            expect(isSuperuserEmail("")).toBe(false);
            expect(isSuperuserEmail("  ")).toBe(false);
            expect(isSuperuserEmail("admin@example.com")).toBe(false);
        });

        it("should match nobody when the env is unset", (): void => {
            delete process.env.SUPERUSER_EMAIL;

            expect(isSuperuserEmail("")).toBe(false);
            expect(isSuperuserEmail("admin@example.com")).toBe(false);
        });
    });
});
