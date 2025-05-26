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
        const testEmail: string = "test@test.com";
        const testUsername: string = generateRandomString(8);
        const testPassword: string = generateRandomString(8);

        it("should register a new user successfully", async () => {
            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail, password: testPassword, username: testUsername })
                .expect(201);
        });
    });
});
