import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { defaultUploadQuotaBytes } from "../helpers/uploadQuota";
import { AdminUser, toAdminUser } from "../helpers/admin";
import { UserModel } from "../database/users";
import { UserUploadsModel } from "../database/userUploads";

interface TestUser {
    id: string;
    username: string;
    email: string;
    cookie: string;
}

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expect(response.status).toBe(200);

    return response.headers["set-cookie"][0];
};

const currentUserId = async (cookie: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .get("/user")
        .set("Cookie", cookie)
        .expect(200);

    return response.body._id;
};

const uploadAs = async (cookie: string, fileName: string): Promise<any> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/upload")
        .set("Cookie", cookie)
        .attach("file", testPng, fileName)
        .expect(201);

    return response.body.upload;
};

describe("Admin API Tests", (): void => {
    const prefix: string = `ad${crypto.randomBytes(4).toString("hex")}`;
    const createdUserIds: string[] = [];
    let superuser: TestUser;
    let user: TestUser;
    let emptyUser: TestUser;

    const registerUser = async (username: string): Promise<TestUser> => {
        const email: string = `${username.toLowerCase()}@test.com`;
        const password: string = crypto.randomBytes(12).toString("hex");

        await request(TestData.apiURL)
            .post("/auth/register")
            .send({ username, email, password })
            .expect(201);

        const cookie: string = await login(email, password);
        const createdUser: TestUser = { id: await currentUserId(cookie), username, email, cookie };

        createdUserIds.push(createdUser.id);

        return createdUser;
    };

    const adminGet = (url: string, cookie: string = superuser.cookie): supertest.Test =>
        request(TestData.apiURL).get(url).set("Cookie", cookie);

    beforeAll(async (): Promise<void> => {
        await mongoose.connect(process.env.DB_CONNECTION_STRING);

        const superuserCookie: string = await login(TestData.email, TestData.password);
        superuser = {
            id: await currentUserId(superuserCookie),
            username: TestData.username,
            email: TestData.email,
            cookie: superuserCookie
        };

        user = await registerUser(`${prefix}a`);
        emptyUser = await registerUser(`${prefix}B`);

        await uploadAs(user.cookie, "admin.png");
    }, 25000);

    afterAll(async (): Promise<void> => {
        for (const id of createdUserIds) {
            await UserUploadsModel.deleteMany({ uploadedBy: id });
            await fs.promises.rm(path.join(process.env.UPLOAD_DISK_DIRECTORY, id), {
                recursive: true,
                force: true
            });
            await UserModel.deleteOne({ _id: id });
        }

        await mongoose.disconnect();
    });

    describe("GET /admin/users", (): void => {
        const listUsers = (query: string, cookie?: string): supertest.Test =>
            adminGet(`/admin/users?${query}`, cookie);

        const usernamesOf = (users: any[]): string[] =>
            users.map((listedUser: any): string => listedUser.username);

        const expectedAdminUser = (
            listedUser: Omit<TestUser, "cookie">,
            usedBytes: number,
            count: number
        ) => ({
            id: listedUser.id,
            username: listedUser.username,
            email: listedUser.email,
            createdAt: expect.any(String),
            isSuperuser: false,
            uploads: {
                usedBytes,
                count,
                quotaBytes: defaultUploadQuotaBytes,
                hasCustomQuota: false
            }
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/users")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await adminGet("/admin/users", user.cookie).expect(
                403
            );

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
                `q=${encodeURIComponent(superuser.username)}&limit=50`
            ).expect(200);

            const listedSuperuser: any = response.body.users.find(
                (listedUser: any): boolean => listedUser.id === superuser.id
            );

            expect(listedSuperuser).toEqual({
                id: superuser.id,
                username: superuser.username,
                email: expect.any(String),
                createdAt: expect.any(String),
                isSuperuser: true,
                uploads: {
                    usedBytes: expect.any(Number),
                    count: expect.any(Number),
                    quotaBytes: expect.any(Number),
                    hasCustomQuota: expect.any(Boolean)
                }
            });
        });

        it("should fall back to the ID timestamp for a user without createdAt", async (): Promise<void> => {
            const legacyId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
            const legacyUsername: string = `lg${crypto.randomBytes(4).toString("hex")}`;
            const legacyEmail: string = `${legacyUsername}@test.com`;

            await UserModel.collection.insertOne({
                _id: legacyId,
                username: legacyUsername,
                email: legacyEmail
            });
            createdUserIds.push(legacyId.toString());

            const response: supertest.Response = await listUsers(
                `q=${legacyUsername}&sortBy=createdAt`
            ).expect(200);

            expect(response.body.users).toEqual([
                {
                    ...expectedAdminUser(
                        { id: legacyId.toString(), username: legacyUsername, email: legacyEmail },
                        0,
                        0
                    ),
                    createdAt: legacyId.getTimestamp().toISOString()
                }
            ]);

            await listUsers("limit=50&sortBy=createdAt&sortOrder=asc").expect(200);
        });

        it("should never return authentication fields", async (): Promise<void> => {
            const response: supertest.Response = await listUsers("limit=50").expect(200);

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

    describe("toAdminUser", (): void => {
        it("should fall back to the ID timestamp without createdAt", (): void => {
            const id: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();

            const adminUser: AdminUser = toAdminUser(
                { _id: id, username: "legacy", email: "legacy@test.com" },
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
            cookie: string = superuser.cookie
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
            quotaUser = await registerUser(`aq${crypto.randomBytes(4).toString("hex")}`);
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
            const response: supertest.Response = await updateQuota(quotaUser.id, body)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.Admin.invalidQuota });
            expect(await ownQuotaBytes(quotaUser.cookie)).toBe(defaultUploadQuotaBytes);
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
});
