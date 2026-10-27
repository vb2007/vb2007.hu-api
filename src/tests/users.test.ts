import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { isSuperuserEmail } from "../helpers";
import { TestUser, createTestUser, login, randomHex, testEmailOf } from "./helpers/testUsers";

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

    describe("PATCH /user/email", (): void => {
        let user: TestUser;
        let other: TestUser;
        let changingUser: TestUser;
        let sameEmailUser: TestUser;
        let githubUser: TestUser;
        let racers: TestUser[];

        const unusedEmail: string = testEmailOf(`em${randomHex(5)}`);

        const changeEmail = (cookie: string, body: object): supertest.Test =>
            request(TestData.apiURL).patch("/user/email").set("Cookie", cookie).send(body);

        const currentEmail = async (cookie: string): Promise<string> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            return response.body.email;
        };

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("em");
            other = await createTestUser("em");
            changingUser = await createTestUser("em");
            sameEmailUser = await createTestUser("em");
            githubUser = await createTestUser("emgh");
            racers = [await createTestUser("emr"), await createTestUser("emr")];

            await mongoose.connect(process.env.DB_CONNECTION_STRING, {
                autoCreate: false,
                autoIndex: false
            });

            await UserModel.updateOne(
                { _id: githubUser.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}` },
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                }
            );
        }, 25000);

        afterAll(async (): Promise<void> => {
            await mongoose.disconnect();
        });

        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch("/user/email")
                .send({ email: testEmailOf(`em${randomHex(5)}`), password: "password" })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should change the e-mail, normalized, and log in with it", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`em${randomHex(5)}`);

            const response: supertest.Response = await changeEmail(changingUser.cookie, {
                email: ` ${newEmail.toUpperCase()} `,
                password: changingUser.password
            }).expect(200);

            expect(response.body).toEqual({ message: Responses.Users.emailUpdatedSuccess });
            expect(await currentEmail(changingUser.cookie)).toBe(newEmail);
            await expect(login(newEmail, changingUser.password)).resolves.toMatch(/VB-AUTH/);

            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: changingUser.email, password: changingUser.password })
                .expect(404);
        });

        it("should accept the current e-mail in another case and keep it", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(sameEmailUser.cookie, {
                email: sameEmailUser.email.toUpperCase(),
                password: sameEmailUser.password
            }).expect(200);

            expect(response.body).toEqual({ message: Responses.Users.emailUpdatedSuccess });
            expect(await currentEmail(sameEmailUser.cookie)).toBe(sameEmailUser.email);
        });

        it.each([
            ["no body", {}],
            ["no password", { email: unusedEmail }],
            ["no e-mail", { password: "password" }],
            ["an empty e-mail", { email: "", password: "password" }],
            ["a non-string e-mail", { email: [unusedEmail], password: "password" }],
            ["a non-string password", { email: unusedEmail, password: 123 }]
        ])("should return 400 for %s", async (_: string, body: object): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, body).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 400 for a malformed e-mail", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: "not-an-email",
                password: user.password
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.invalidEmailFormat
            );
        });

        it("should return 403 for a wrong password", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: testEmailOf(`em${randomHex(5)}`),
                password: `${user.password}x`
            }).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
            expect(await currentEmail(user.cookie)).toBe(user.email);
        });

        it.each([
            ["another user's e-mail", (): string => other.email.toUpperCase()],
            ["the superuser's e-mail", (): string => TestData.superuser.email]
        ])(
            "should check the password before %s",
            async (_: string, email: () => string): Promise<void> => {
                const response: supertest.Response = await changeEmail(user.cookie, {
                    email: email(),
                    password: `${user.password}x`
                }).expect(403);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.incorrectPassword
                );
                expect(await currentEmail(user.cookie)).toBe(user.email);
            }
        );

        it("should return 409 for another user's e-mail in another case", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: other.email.toUpperCase(),
                password: user.password
            }).expect(409);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.emailAlreadyExists
            );
            expect(await currentEmail(user.cookie)).toBe(user.email);
        });

        it("should give one of two concurrent changes to the same e-mail a 409", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`em${randomHex(5)}`);

            const responses: supertest.Response[] = await Promise.all(
                racers.map((racer: TestUser) =>
                    changeEmail(racer.cookie, { email: newEmail, password: racer.password })
                )
            );

            expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
            expect(
                await Promise.all(racers.map((racer: TestUser) => currentEmail(racer.cookie)))
            ).toContain(newEmail);
        });

        it("should return 403 when changing to the superuser's e-mail", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: TestData.superuser.email,
                password: user.password
            }).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Users.emailReservedForSuperuser
            );
            expect(await currentEmail(user.cookie)).toBe(user.email);
        });

        it("should return 403 when the superuser changes its e-mail", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(TestData.superuser.cookie, {
                email: testEmailOf(`em${randomHex(5)}`),
                password: "password"
            }).expect(403);

            expect(response.body).toHaveProperty("error", Responses.Users.superuserEmailChange);
            expect(await currentEmail(TestData.superuser.cookie)).toBe(TestData.superuser.email);
        });

        it("should return 409 for an account without a password", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(githubUser.cookie, {
                email: testEmailOf(`em${randomHex(5)}`),
                password: "password"
            }).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Users.noPasswordToChangeEmail);
            expect(await currentEmail(githubUser.cookie)).toBe(githubUser.email);
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
