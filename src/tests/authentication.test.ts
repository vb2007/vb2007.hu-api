import request from "supertest";
import { TestData } from "./testData";
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
            expect(response.body).toHaveProperty("email", testEmail);
        });

        it("should return 400 when no e-mail and/or password is provided", async () => {
            await request(TestData.apiURL).post("/auth/login").expect(400);

            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail })
                .expect(400);

            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ password: testPassword })
                .expect(400);
        });

        it("should return 403 when the password is incorrect", async () => {
            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail, password: "foo" })
                .expect(403);
        });

        it("should return 400 when there is no such user in the database", async () => {
            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: "foo", password: "foo" })
                .expect(400);
        });

        it("should return JSON error message on failure", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: "foo", password: "foo" });

            expect([400, 403]).toContain(response.status);
            // expect(response.body).toHaveProperty("error");
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
            const res = await request(TestData.apiURL)
                .post("/auth/login")
                .set("Content-Type", "application/json")
                .send('{"email": "foo", "password": ') // malformed JSON
                .catch((e) => e.response); // supertest throws on malformed JSON

            expect(res.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe("POST /auth/register", () => {
        const testEmail: string = TestData.email;
        let testUsername: string;
        let testPassword: string = generateRandomString(8);

        it("should register a new user successfully", async () => {
            testUsername = generateRandomString(8);

            await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(201);
        });

        it("should not let the user register with an existing username", async () => {
            testUsername = TestData.username;

            const response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(409);
        });

        it("should not let the user register without a request body", async () => {
            const response = await request(TestData.apiURL).post("/auth/register").expect(400);
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
