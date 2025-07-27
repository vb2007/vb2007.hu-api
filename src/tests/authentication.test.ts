import request from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { generateRandomString } from "../helpers/text";

describe("Authentication API Tests", () => {
    describe("POST /auth/login", () => {
        const testEmail: string = TestData.email;
        const testPassword: string = TestData.password;

        it("should log in a user successfully with valid credentials", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail, password: testPassword })
                .expect(200);

            expect(response.headers["set-cookie"]).toBeDefined();
            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.loginSuccess(TestData.username)
            );
        });

        it("should return 400 when nothing is provided", async () => {
            const response = await request(TestData.apiURL).post("/auth/login").expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 400 when no e-mail is provided", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ password: testPassword })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 400 when no password is provided", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail })
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 403 when the password is incorrect", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail, password: "foo" })
                .expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
        });

        it("should return 404 when there is no such user in the database", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: "foo", password: "foo" })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.Authentication.userNotFound);
        });

        it("should set session cookie with correct attributes", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: TestData.email, password: TestData.password })
                .expect(200);

            const cookie = response.headers["set-cookie"][0];
            expect(cookie).toMatch(/VB-AUTH/);
            expect(cookie).toMatch(/Path=\//);
        });

        it("should not leak sensitive fields in response", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail, password: testPassword })
                .expect(200);

            expect(response.body).not.toHaveProperty("authentication.password");
            expect(response.body).not.toHaveProperty("authentication.salt");
        });

        it("should handle malformed JSON gracefully", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .set("Content-Type", "application/json")
                .send('{"email": "foo", "password": ') // malformed JSON
                .catch((e) => e.response); // supertest throws on malformed JSON

            expect(response.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe("POST /auth/register", () => {
        let testEmail: string = TestData.email;
        let testUsername: string;
        let testPassword: string = generateRandomString(8);

        it("should register a new user successfully", async () => {
            testEmail = generateRandomString(8) + "@example.com";
            testUsername = generateRandomString(8);

            const response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(201);

            expect(response.body).toHaveProperty(
                "message",
                Responses.Authentication.registrationSuccess(testUsername)
            );
        });

        it("should not let the user register with an existing email", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({
                    email: testEmail,
                    password: testPassword,
                    username: generateRandomString(8)
                })
                .expect(409);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.emailAlreadyExists
            );
        });

        it("should not let the user register with an existing username", async () => {
            testEmail = generateRandomString(8) + "@example.com";
            testUsername = TestData.username;

            const response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(409);

            expect(response.body).toHaveProperty("error", Responses.Authentication.usernameTaken);
        });

        it("should not let the user register without a request body", async () => {
            const response = await request(TestData.apiURL).post("/auth/register").expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPasswordUsername
            );
        });

        test.each([
            ["null email", null, generateRandomString(8), generateRandomString(8)],
            ["null username", TestData.email, null, generateRandomString(8)],
            ["null password", TestData.email, generateRandomString(8), null],
            ["empty email", "", generateRandomString(8), generateRandomString(8)],
            ["empty username", TestData.email, "", generateRandomString(8)],
            ["empty password", TestData.email, generateRandomString(8), ""]
        ])(
            "should reject registration with %s",
            async (description: string, email: any, username: any, password: any) => {
                const payload: any = {};
                if (email !== undefined) payload.email = email;
                if (username !== undefined) payload.username = username;
                if (password !== undefined) payload.password = password;

                const response = await request(TestData.apiURL)
                    .post("/auth/register")
                    .send(payload);

                expect(response.status).toBe(400);
            }
        );
    });
});
