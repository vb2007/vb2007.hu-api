import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { isSuperuserEmail } from "../helpers";
import { TestUser, createTestUser } from "./helpers/testUsers";

describe("Users API Tests", (): void => {
    describe("GET /user", (): void => {
        let other: TestUser;

        beforeAll(async (): Promise<void> => {
            other = await createTestUser();
        }, 25000);

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
