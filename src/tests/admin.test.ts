import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { defaultUploadQuotaBytes } from "../helpers/uploadQuota";
import { TestUser, createTestUser, randomHex } from "./helpers/testUsers";

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const uploadAs = async (cookie: string, fileName: string): Promise<any> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/upload")
        .set("Cookie", cookie)
        .attach("file", testPng, fileName)
        .expect(201);

    return response.body.upload;
};

const listUsers = (query: string, cookie: string = TestData.superuser.cookie): supertest.Test =>
    request(TestData.apiURL).get(`/admin/users?${query}`).set("Cookie", cookie);

const expectedAdminUser = (
    listedUser: Pick<TestUser, "id" | "username" | "email">,
    usedBytes: number,
    count: number,
    isSuperuser: boolean = false
) => ({
    id: listedUser.id,
    username: listedUser.username,
    email: listedUser.email,
    createdAt: expect.any(String),
    isSuperuser,
    uploads: {
        usedBytes,
        count,
        quotaBytes: defaultUploadQuotaBytes,
        hasCustomQuota: false
    }
});

describe("Admin API Tests", (): void => {
    const prefix: string = `x${randomHex(2)}`;
    let user: TestUser;
    let emptyUser: TestUser;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser(`${prefix}a`);
        emptyUser = await createTestUser(`${prefix}B`);

        await uploadAs(user.cookie, "admin.png");
    }, 25000);

    describe("GET /admin/users", (): void => {
        const usernamesOf = (users: any[]): string[] =>
            users.map((listedUser: any): string => listedUser.username);

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/users")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await listUsers("", user.cookie).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should list the users with their upload usage", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(`q=${prefix}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                users: [
                    expectedAdminUser(user, testPng.length, 1),
                    expectedAdminUser(emptyUser, 0, 0)
                ],
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 2,
                    pages: 1,
                    sortBy: "usedBytes",
                    sortOrder: "desc"
                }
            });

            for (const listedUser of response.body.users) {
                expect(new Date(listedUser.createdAt).toISOString()).toBe(listedUser.createdAt);
            }
        });

        it("should list the superuser as a superuser", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${TestData.superuser.username}`
            ).expect(200);

            expect(response.body.users).toEqual([
                expectedAdminUser(TestData.superuser, 0, 0, true)
            ]);
        });

        it("should never return authentication fields", async (): Promise<void> => {
            for (const query of [`q=${prefix}`, `q=${TestData.superuser.username}`]) {
                const response: supertest.Response = await listUsers(query).expect(200);

                expect(response.body.users.length).toBeGreaterThan(0);

                for (const listedUser of response.body.users) {
                    expect(Object.keys(listedUser).sort()).toEqual([
                        "createdAt",
                        "email",
                        "id",
                        "isSuperuser",
                        "uploads",
                        "username"
                    ]);
                }

                expect(JSON.stringify(response.body)).not.toMatch(
                    /authentication|password|salt|sessionToken|uploadQuotaBytes/
                );
            }
        });

        it("should match q case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${prefix.toUpperCase()}A`
            ).expect(200);

            expect(usernamesOf(response.body.users)).toEqual([user.username]);
        });

        it("should match regex characters in q literally", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${encodeURIComponent(`${prefix}.`)}`
            ).expect(200);

            expect(response.body.users).toEqual([]);
            expect(response.body.pagination.total).toBe(0);
        });

        it("should sort by usedBytes ascending", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${prefix}&sortOrder=asc`
            ).expect(200);

            expect(usernamesOf(response.body.users)).toEqual([emptyUser.username, user.username]);
        });

        it("should sort by username case-insensitively", async (): Promise<void> => {
            const ascResponse: supertest.Response = await listUsers(
                `q=${prefix}&sortBy=username&sortOrder=asc`
            ).expect(200);

            expect(usernamesOf(ascResponse.body.users)).toEqual([
                user.username,
                emptyUser.username
            ]);
            expect(ascResponse.body.pagination).toMatchObject({
                sortBy: "username",
                sortOrder: "asc"
            });

            const descResponse: supertest.Response = await listUsers(
                `q=${prefix}&sortBy=username&sortOrder=desc`
            ).expect(200);

            expect(usernamesOf(descResponse.body.users)).toEqual([
                emptyUser.username,
                user.username
            ]);
        });

        it("should sort by createdAt", async (): Promise<void> => {
            const ascResponse: supertest.Response = await listUsers(
                `q=${prefix}&sortBy=createdAt&sortOrder=asc`
            ).expect(200);

            expect(usernamesOf(ascResponse.body.users)).toEqual([
                user.username,
                emptyUser.username
            ]);

            const descResponse: supertest.Response = await listUsers(
                `q=${prefix}&sortBy=createdAt`
            ).expect(200);

            expect(usernamesOf(descResponse.body.users)).toEqual([
                emptyUser.username,
                user.username
            ]);
        });

        it("should page the filtered result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listUsers(
                `q=${prefix}&limit=1&page=2`
            ).expect(200);

            expect(pageTwo.body).toEqual({
                users: [expectedAdminUser(emptyUser, 0, 0)],
                pagination: {
                    limit: 1,
                    page: 2,
                    total: 2,
                    pages: 2,
                    sortBy: "usedBytes",
                    sortOrder: "desc"
                }
            });

            const pageThree: supertest.Response = await listUsers(
                `q=${prefix}&limit=1&page=3`
            ).expect(200);

            expect(pageThree.body.users).toEqual([]);
            expect(pageThree.body.pagination.total).toBe(2);
        });

        it("should return an empty page for the largest page number", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${prefix}&limit=50&page=${Number.MAX_SAFE_INTEGER}`
            ).expect(200);

            expect(response.body).toEqual({
                users: [],
                pagination: {
                    limit: 50,
                    page: Number.MAX_SAFE_INTEGER,
                    total: 2,
                    pages: 1,
                    sortBy: "usedBytes",
                    sortOrder: "desc"
                }
            });
        });

        it.each([
            ["limit", "limit=0"],
            ["limit", "limit=51"],
            ["limit", "limit=1.5"],
            ["limit", "limit=abc"],
            ["limit", "limit=1&limit=2"],
            ["page", "page=0"],
            ["page", "page=-1"],
            ["page", "page=9007199254740992"],
            ["sortBy", "sortBy=email"],
            ["sortOrder", "sortOrder=up"],
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=a&q=b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listUsers(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.Admin.invalidQuery(param) });
        });
    });
});
