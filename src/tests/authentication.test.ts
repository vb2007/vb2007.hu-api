import request from "supertest";
import mongoose from "mongoose";
import { TestData } from "./testData";

describe("Authentication API Tests", () => {
    describe("POST /auth/login", () => {
        const testEmail: string = TestData.email;
        const testPassword: string = TestData.password;

        it("should log in a user successfully with valid credentials", async () => {
            const response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: testEmail, password: testPassword })
                .expect(200);
        });

        it("should return 400 when no e-mail and/or password is provided", async () => {
            await request(TestData.apiURL).post("/auth/login").expect(400);
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
    });
});
