import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { defaultUploadQuotaBytes } from "../helpers/uploadQuota";
import { AdminUser, toAdminUser } from "../helpers/admin";
import { UserModel } from "../database/users";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";

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

    describe("GET /admin/users for a user without createdAt", (): void => {
        const legacyId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
        const legacyUsername: string = `l${randomHex(5)}`;

        beforeAll(async (): Promise<void> => {
            await mongoose.connect(process.env.DB_CONNECTION_STRING);

            await UserModel.collection.insertOne({
                _id: legacyId,
                username: legacyUsername,
                email: testEmailOf(legacyUsername)
            });
        });

        afterAll(async (): Promise<void> => {
            await mongoose.disconnect();
        });

        it("should fall back to the ID timestamp", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${legacyUsername}&sortBy=createdAt`
            ).expect(200);

            expect(response.body.users).toEqual([
                {
                    ...expectedAdminUser(
                        {
                            id: legacyId.toString(),
                            username: legacyUsername,
                            email: testEmailOf(legacyUsername)
                        },
                        0,
                        0
                    ),
                    createdAt: legacyId.getTimestamp().toISOString()
                }
            ]);
        });
    });

    describe("toAdminUser", (): void => {
        it("should fall back to the ID timestamp without createdAt", (): void => {
            const id: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();

            const adminUser: AdminUser = toAdminUser(
                { _id: id, username: "legacy", email: testEmailOf("legacy") },
                { usedBytes: 0, count: 0 }
            );

            expect(adminUser.createdAt).toBe(id.getTimestamp().toISOString());
        });
    });

    describe("PATCH /admin/users/:id/upload-quota", (): void => {
        let quotaUser: TestUser;
        let quotaUpload: any;

        const updateQuota = (
            id: string,
            body: object,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL)
                .patch(`/admin/users/${id}/upload-quota`)
                .set("Cookie", cookie)
                .send(body);

        const ownQuotaBytes = async (cookie: string): Promise<number> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/uploads/usage")
                .set("Cookie", cookie)
                .expect(200);

            return response.body.quotaBytes;
        };

        const expectedUpdate = (quotaBytes: number, hasCustomQuota: boolean) => ({
            message: Responses.Admin.quotaUpdatedSuccess,
            user: {
                id: quotaUser.id,
                username: quotaUser.username,
                email: quotaUser.email,
                createdAt: expect.any(String),
                isSuperuser: false,
                uploads: {
                    usedBytes: testPng.length,
                    count: 1,
                    quotaBytes,
                    hasCustomQuota
                }
            }
        });

        beforeAll(async (): Promise<void> => {
            quotaUser = await createTestUser("quota");
            quotaUpload = await uploadAs(quotaUser.cookie, "quota.png");
        }, 15000);

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/admin/users/${quotaUser.id}/upload-quota`)
                .send({ quotaBytes: 1024 })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await updateQuota(
                quotaUser.id,
                { quotaBytes: 1024 },
                quotaUser.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should return 400 for an invalid id", async (): Promise<void> => {
            const response: supertest.Response = await updateQuota("invalid-id", {
                quotaBytes: 1024
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for an unknown user", async (): Promise<void> => {
            const response: supertest.Response = await updateQuota(
                new mongoose.Types.ObjectId().toString(),
                { quotaBytes: 1024 }
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });

        it.each([
            ["a negative", { quotaBytes: -1 }],
            ["a fractional", { quotaBytes: 1.5 }],
            ["a string", { quotaBytes: "1024" }],
            ["a boolean", { quotaBytes: true }],
            ["an unsafe", { quotaBytes: Number.MAX_SAFE_INTEGER + 1 }],
            ["a missing", {}]
        ])("should return 400 for %s quota", async (_: string, body: object) => {
            const quotaBytesBefore: number = await ownQuotaBytes(quotaUser.cookie);

            const response: supertest.Response = await updateQuota(quotaUser.id, body)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.Admin.invalidQuota });
            expect(await ownQuotaBytes(quotaUser.cookie)).toBe(quotaBytesBefore);
        });

        it("should set a custom quota", async (): Promise<void> => {
            const quotaBytes: number = 5 * 1024 * 1024;

            const response: supertest.Response = await updateQuota(quotaUser.id, { quotaBytes })
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual(expectedUpdate(quotaBytes, true));
            expect(await ownQuotaBytes(quotaUser.cookie)).toBe(quotaBytes);
        });

        it("should accept a quota of 0", async (): Promise<void> => {
            const response: supertest.Response = await updateQuota(quotaUser.id, {
                quotaBytes: 0
            }).expect(200);

            expect(response.body).toEqual(expectedUpdate(0, true));
            expect(await ownQuotaBytes(quotaUser.cookie)).toBe(0);
        });

        it("should keep existing uploads but reject new ones over a lowered quota", async (): Promise<void> => {
            await updateQuota(quotaUser.id, { quotaBytes: testPng.length }).expect(200);

            const uploadResponse: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", quotaUser.cookie)
                .attach("file", testPng, "over-quota.png")
                .expect(413);

            expect(uploadResponse.body).toEqual({ error: Responses.UserUploads.quotaExceeded });

            const listResponse: supertest.Response = await request(TestData.apiURL)
                .get("/uploads")
                .set("Cookie", quotaUser.cookie)
                .expect(200);

            expect(listResponse.body.uploads).toEqual([quotaUpload]);
        });

        it("should reset to the default quota with null", async (): Promise<void> => {
            const response: supertest.Response = await updateQuota(quotaUser.id, {
                quotaBytes: null
            }).expect(200);

            expect(response.body).toEqual(expectedUpdate(defaultUploadQuotaBytes, false));
            expect(await ownQuotaBytes(quotaUser.cookie)).toBe(defaultUploadQuotaBytes);
        });
    });

    describe("GET /admin/users/:id/uploads", (): void => {
        const uploads: any[] = [];
        let owner: TestUser;

        const listUserUploads = (
            id: string,
            query: string = "",
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL)
                .get(`/admin/users/${id}/uploads?${query}`)
                .set("Cookie", cookie);

        const namesOf = (list: any[]): string[] =>
            list.map((upload: any): string => upload.originalFileName);

        beforeAll(async (): Promise<void> => {
            owner = await createTestUser("up");

            uploads.push(await uploadAs(owner.cookie, "b.png"));
            uploads.push(await uploadAs(owner.cookie, "A.png"));
            uploads.push(await uploadAs(owner.cookie, "c.png"));

            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/upload/${uploads[1].id}`)
                .set("Cookie", owner.cookie)
                .send({ visibility: "public" })
                .expect(200);

            uploads[1] = response.body.upload;
        }, 25000);

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/admin/users/${owner.id}/uploads`)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await listUserUploads(
                owner.id,
                "",
                owner.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should list the user's uploads, newest first", async (): Promise<void> => {
            const response: supertest.Response = await listUserUploads(owner.id)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                user: { id: owner.id, username: owner.username },
                uploads: [...uploads].reverse(),
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 3,
                    pages: 1,
                    sortBy: "uploadedOn",
                    sortOrder: "desc"
                }
            });
        });

        it("should list no uploads for a user without any", async (): Promise<void> => {
            const response: supertest.Response = await listUserUploads(emptyUser.id).expect(200);

            expect(response.body).toEqual({
                user: { id: emptyUser.id, username: emptyUser.username },
                uploads: [],
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 0,
                    pages: 0,
                    sortBy: "uploadedOn",
                    sortOrder: "desc"
                }
            });
        });

        it("should filter by visibility", async (): Promise<void> => {
            const publicResponse: supertest.Response = await listUserUploads(
                owner.id,
                "visibility=public"
            ).expect(200);

            expect(publicResponse.body.uploads).toEqual([uploads[1]]);
            expect(publicResponse.body.pagination.total).toBe(1);

            const privateResponse: supertest.Response = await listUserUploads(
                owner.id,
                "visibility=private"
            ).expect(200);

            expect(privateResponse.body.uploads).toEqual([uploads[2], uploads[0]]);
            expect(privateResponse.body.pagination.total).toBe(2);
        });

        it("should sort by originalFileName case-insensitively", async (): Promise<void> => {
            const ascResponse: supertest.Response = await listUserUploads(
                owner.id,
                "sortBy=originalFileName&sortOrder=asc"
            ).expect(200);

            expect(namesOf(ascResponse.body.uploads)).toEqual(["A.png", "b.png", "c.png"]);
            expect(ascResponse.body.pagination).toMatchObject({
                sortBy: "originalFileName",
                sortOrder: "asc"
            });

            const descResponse: supertest.Response = await listUserUploads(
                owner.id,
                "sortBy=originalFileName&sortOrder=desc"
            ).expect(200);

            expect(namesOf(descResponse.body.uploads)).toEqual(["c.png", "b.png", "A.png"]);
        });

        it("should match q case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listUserUploads(owner.id, "q=a").expect(200);

            expect(response.body.uploads).toEqual([uploads[1]]);
            expect(response.body.pagination.total).toBe(1);
        });

        it("should page the result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listUserUploads(
                owner.id,
                "sortOrder=asc&limit=2&page=2"
            ).expect(200);

            expect(pageTwo.body).toEqual({
                user: { id: owner.id, username: owner.username },
                uploads: [uploads[2]],
                pagination: {
                    limit: 2,
                    page: 2,
                    total: 3,
                    pages: 2,
                    sortBy: "uploadedOn",
                    sortOrder: "asc"
                }
            });
        });

        it.each([
            ["limit", "limit=0"],
            ["limit", "limit=51"],
            ["limit", "limit=1&limit=2"],
            ["page", "page=0"],
            ["sortBy", "sortBy=addedOn"],
            ["sortOrder", "sortOrder=up"],
            ["visibility", "visibility=secret"],
            ["q", `q=${"a".repeat(101)}`]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listUserUploads(owner.id, query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.UserUploads.invalidQuery(param) });
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            const response: supertest.Response = await listUserUploads("not-an-id").expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for a non-existing user ID", async (): Promise<void> => {
            const response: supertest.Response = await listUserUploads(
                new mongoose.Types.ObjectId().toString()
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });
    });
});
