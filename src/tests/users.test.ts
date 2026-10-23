import request from "supertest";
import supertest from "supertest";
import crypto from "crypto";
import { TestData } from "../constants/testData";
import { isSuperuserEmail } from "../helpers";

const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expect(response.status).toBe(200);

    return response.headers["set-cookie"][0];
};

describe("Users API Tests", (): void => {
    describe("GET /user", (): void => {
        let authCookie: string;
        let otherCookie: string;
        let otherUserId: string;

        const otherUsername: string = `t${crypto.randomBytes(6).toString("hex")}`;
        const otherEmail: string = `${otherUsername}@test.com`;
        const otherPassword: string = crypto.randomBytes(12).toString("hex");

        beforeAll(async (): Promise<void> => {
            authCookie = await login(TestData.email, TestData.password);

            const registerResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ username: otherUsername, email: otherEmail, password: otherPassword });

            expect(registerResponse.status).toBe(201);

            otherCookie = await login(otherEmail, otherPassword);

            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", otherCookie);

            otherUserId = userResponse.body._id;
        }, 25000);

        afterAll(async (): Promise<void> => {
            if (otherUserId) {
                await request(TestData.apiURL)
                    .delete(`/users/${otherUserId}`)
                    .set("Cookie", otherCookie);
            }
        });

        it("should mark the superuser as isSuperuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", authCookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", TestData.email);
            expect(response.body).toHaveProperty("isSuperuser", true);
        });

        it("should not mark another user as isSuperuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", otherCookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", otherEmail);
            expect(response.body).toHaveProperty("isSuperuser", false);
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
