import express from "express";
import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import {
    CODE_FAILURES_PER_DAY,
    EMAIL_CODE_RESEND_SECONDS,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    PASTE_PREVIEW_LENGTH
} from "../constants/limits";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { maxFileSizeBytes } from "../helpers/multer";
import { defaultUploadQuotaBytes } from "../helpers/uploadQuota";
import { AdminUser, toAdminShortUrl, toAdminUser, toUploadTotals } from "../helpers/admin";
import { verifyRegistration as verifyRegistrationHandler } from "../controllers/authentication";
import * as usersDatabase from "../database/users";
import {
    UserModel,
    passwordResetLinkScope,
    passwordResetScope,
    setPasswordReset
} from "../database/users";
import { PastebinModel } from "../database/pastebin";
import { ShortUrlModel } from "../database/shortUrls";
import { UserUploadsModel } from "../database/userUploads";
import { PendingRegistrationModel, registrationCodeScope } from "../database/pendingRegistrations";
import { authentication } from "../helpers";
import {
    EmailCodeFailures,
    createEmailCode,
    hashEmailCode,
    issueEmailCode
} from "../helpers/emailCodes";
import { deviceCookie } from "../helpers/deviceCookie";
import { createOauthSecret } from "../helpers/github";
import * as mail from "../helpers/mail";
import * as password from "../helpers/password";
import {
    TestUser,
    addPasteAndShortUrl,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    randomHex,
    registerRequest,
    registerTestUser,
    sameUpload,
    setRegistrationCode,
    storeSession,
    storedAuthentication,
    testEmailOf,
    verifyRegistration
} from "./helpers/testUsers";
import { runRequestReset } from "./helpers/passwordReset";
import { runResendRegistration } from "./helpers/emailHandlers";

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const uploadAs = async (
    cookie: string,
    fileName: string,
    visibility: string = "private"
): Promise<any> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/upload")
        .set("Cookie", cookie)
        .field("visibility", visibility)
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
    suspendedAt: null as string | null,
    uploads: {
        usedBytes,
        count,
        quotaBytes: defaultUploadQuotaBytes,
        hasCustomQuota: false
    }
});

describe("Admin API Tests", (): void => {
    const prefix: string = `x${randomHex(6)}`;
    let user: TestUser;
    let emptyUser: TestUser;

    beforeAll(async (): Promise<void> => {
        user = await registerTestUser(`${prefix}a`);
        emptyUser = await registerTestUser(`${prefix}B`);

        await uploadAs(user.cookie, "admin.png");
    });

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
                        "suspendedAt",
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
            ["q", "q=a&q=b"],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listUsers(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
        });

        it.each(["username", "createdAt"])(
            "should return the upload usage of each page when sorted by %s",
            async (sortBy: string): Promise<void> => {
                const query: string = `q=${prefix}&sortBy=${sortBy}&sortOrder=asc&limit=1`;

                const pageOne: supertest.Response = await listUsers(`${query}&page=1`).expect(200);
                const pageTwo: supertest.Response = await listUsers(`${query}&page=2`).expect(200);

                expect(pageOne.body.users).toEqual([expectedAdminUser(user, testPng.length, 1)]);
                expect(pageTwo.body.users).toEqual([expectedAdminUser(emptyUser, 0, 0)]);
                expect(pageTwo.body.pagination).toMatchObject({ total: 2, pages: 2, sortBy });
            }
        );
    });

    describe("GET /admin/users for a user without createdAt", (): void => {
        const legacyId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
        const legacyUsername: string = `l${randomHex(5)}`;

        beforeAll(async (): Promise<void> => {
            await UserModel.collection.insertOne({
                _id: legacyId,
                username: legacyUsername,
                email: testEmailOf(legacyUsername)
            });
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

    describe("GET /admin/users by e-mail", (): void => {
        const emailPrefix: string = `e${randomHex(6)}`;
        let mailUser: TestUser;

        beforeAll(async (): Promise<void> => {
            mailUser = await registerTestUser(`m${randomHex(5)}`, testEmailOf(`${emailPrefix}c`));
        });

        it("should match q against the e-mail address", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(`q=${emailPrefix}`).expect(200);

            expect(response.body.users).toEqual([expectedAdminUser(mailUser, 0, 0)]);
            expect(response.body.pagination.total).toBe(1);
        });

        it("should match the e-mail address case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${emailPrefix.toUpperCase()}C`
            ).expect(200);

            expect(response.body.users).toEqual([expectedAdminUser(mailUser, 0, 0)]);
        });

        it("should match regex characters in q literally against the e-mail address", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${encodeURIComponent(`${emailPrefix}.@`)}`
            ).expect(200);

            expect(response.body.users).toEqual([]);
            expect(response.body.pagination.total).toBe(0);
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

    describe("GET /admin/users/:id", (): void => {
        let freshUser: TestUser;
        let contentUser: TestUser;
        let suspendedUser: TestUser;
        let changingUser: TestUser;
        let githubUser: TestUser;
        let suspendedAt: string;
        const newEmail: string = testEmailOf(`dm${randomHex(5)}`);

        const getUserDetails = (
            id: string,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).get(`/admin/users/${id}`).set("Cookie", cookie);

        const expectedDetails = (
            detailsUser: TestUser,
            counts: { pastes: number; shortUrls: number; uploads: number } = {
                pastes: 0,
                shortUrls: 0,
                uploads: 0
            }
        ) => ({
            user: {
                ...expectedAdminUser(detailsUser, counts.uploads * testPng.length, counts.uploads),
                hasPassword: true,
                emailVerified: true,
                githubLogin: null as string | null,
                pendingEmail: null as string | null,
                counts
            }
        });

        beforeAll(async (): Promise<void> => {
            freshUser = await createTestUser("det");
            contentUser = await createTestUser("det");
            suspendedUser = await createTestUser("det");
            changingUser = await createTestUser("det");
            githubUser = await createTestUser("det");

            await addPasteAndShortUrl(contentUser.cookie);
            await uploadAs(contentUser.cookie, "details.png");

            const suspension: supertest.Response = await request(TestData.apiURL)
                .patch(`/admin/users/${suspendedUser.id}/suspension`)
                .set("Cookie", TestData.superuser.cookie)
                .send({ suspended: true })
                .expect(200);
            suspendedAt = suspension.body.user.suspendedAt;

            await request(TestData.apiURL)
                .patch("/user/email")
                .set("Cookie", changingUser.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: newEmail, password: changingUser.password })
                .expect(202);

            await linkGithub(githubUser, true);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/admin/users/${freshUser.id}`)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(
                freshUser.id,
                freshUser.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should return 400 for an invalid id", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails("invalid-id").expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for an unknown user", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(
                new mongoose.Types.ObjectId().toString()
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });

        it("should return a fresh user's details", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(freshUser.id)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual(expectedDetails(freshUser));
            expect(new Date(response.body.user.createdAt).toISOString()).toBe(
                response.body.user.createdAt
            );
        });

        it("should count the user's pastes, short links and uploads", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(contentUser.id).expect(200);

            expect(response.body).toEqual(
                expectedDetails(contentUser, { pastes: 1, shortUrls: 1, uploads: 1 })
            );
        });

        it("should return when the user was suspended", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(suspendedUser.id).expect(200);

            expect(suspendedAt).toEqual(expect.any(String));
            expect(response.body.user.suspendedAt).toBe(suspendedAt);
        });

        it("should return a pending e-mail change", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(changingUser.id).expect(200);

            expect(response.body.user).toMatchObject({
                email: changingUser.email,
                pendingEmail: newEmail
            });
        });

        it("should return the GitHub login of a user without a password", async (): Promise<void> => {
            const response: supertest.Response = await getUserDetails(githubUser.id).expect(200);

            expect(response.body.user).toMatchObject({
                hasPassword: false,
                githubLogin: expect.stringMatching(/^gh-[0-9a-f]{10}$/)
            });
        });

        it("should never return authentication fields", async (): Promise<void> => {
            for (const detailsUser of [freshUser, contentUser, changingUser, githubUser]) {
                const response: supertest.Response = await getUserDetails(detailsUser.id).expect(
                    200
                );

                expect(Object.keys(response.body)).toEqual(["user"]);
                expect(Object.keys(response.body.user).sort()).toEqual([
                    "counts",
                    "createdAt",
                    "email",
                    "emailVerified",
                    "githubLogin",
                    "hasPassword",
                    "id",
                    "isSuperuser",
                    "pendingEmail",
                    "suspendedAt",
                    "uploads",
                    "username"
                ]);

                expect(Object.keys(response.body.user.uploads).sort()).toEqual([
                    "count",
                    "hasCustomQuota",
                    "quotaBytes",
                    "usedBytes"
                ]);
                expect(Object.keys(response.body.user.counts).sort()).toEqual([
                    "pastes",
                    "shortUrls",
                    "uploads"
                ]);
            }
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
                suspendedAt: null as string | null,
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
        });

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

            expect(listResponse.body.uploads).toEqual([quotaUpload].map(sameUpload));
        });

        it("should reset to the default quota with null", async (): Promise<void> => {
            const response: supertest.Response = await updateQuota(quotaUser.id, {
                quotaBytes: null
            }).expect(200);

            expect(response.body).toEqual(expectedUpdate(defaultUploadQuotaBytes, false));
            expect(await ownQuotaBytes(quotaUser.cookie)).toBe(defaultUploadQuotaBytes);
        });
    });

    describe("PATCH /admin/users/:id", (): void => {
        let renamedUser: TestUser;
        let otherUser: TestUser;
        let outsider: TestUser;
        let upperIdUser: TestUser;
        let charsetUser: TestUser;

        const renameUser = (
            id: string,
            body: object,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).patch(`/admin/users/${id}`).set("Cookie", cookie).send(body);

        const ownUsername = async (cookie: string): Promise<string> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            return response.body.username;
        };

        const expectedRename = (renamed: TestUser, username: string) => ({
            message: Responses.Admin.userRenamedSuccess,
            user: expectedAdminUser({ ...renamed, username }, 0, 0)
        });

        beforeAll(async (): Promise<void> => {
            [renamedUser, otherUser, outsider, upperIdUser, charsetUser] = await Promise.all([
                createTestUser("ren"),
                createTestUser("oth"),
                createTestUser("out"),
                createTestUser("upp"),
                createTestUser("chr")
            ]);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/admin/users/${renamedUser.id}`)
                .send({ username: `${renamedUser.username}x` })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await renameUser(
                renamedUser.id,
                { username: `${renamedUser.username}x` },
                outsider.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
            expect(await ownUsername(renamedUser.cookie)).toBe(renamedUser.username);
        });

        it("should return 400 for an invalid id", async (): Promise<void> => {
            const response: supertest.Response = await renameUser("invalid-id", {
                username: `${renamedUser.username}x`
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for an unknown user", async (): Promise<void> => {
            const response: supertest.Response = await renameUser(
                new mongoose.Types.ObjectId().toString(),
                { username: `${renamedUser.username}x` }
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });

        it.each([
            ["a missing", (): object => ({}), Responses.Users.missingUsername],
            ["an empty", (): object => ({ username: "" }), Responses.Users.missingUsername],
            ["a non-string", (): object => ({ username: 42 }), Responses.Users.missingUsername],
            [
                "a too short",
                (): object => ({ username: "x" }),
                Responses.Authentication.usernameTooShort
            ],
            [
                "a whitespace-padded too short",
                (): object => ({ username: "  a  " }),
                Responses.Authentication.usernameTooShort
            ],
            [
                "a too long",
                (): object => ({ username: `${renamedUser.username}${randomHex(2)}` }),
                Responses.Authentication.usernameTooLong
            ],
            [
                "a word-joiner-only",
                (): object => ({ username: "\u2060\u2060" }),
                Responses.Authentication.usernameInvalidCharacters
            ],
            [
                "a zero-width space",
                (): object => ({ username: "a\u200b" }),
                Responses.Authentication.usernameInvalidCharacters
            ],
            [
                "a tab inside",
                (): object => ({ username: "Rv\tBase" }),
                Responses.Authentication.usernameInvalidCharacters
            ],
            [
                "a braille-blank-only",
                (): object => ({ username: "\u2800\u2800" }),
                Responses.Authentication.usernameInvalidCharacters
            ],
            [
                "a cantillation mark",
                (): object => ({ username: "a\u0591" }),
                Responses.Authentication.usernameInvalidCharacters
            ],
            [
                "a combining-marks-only",
                (): object => ({ username: "\u0301\u0301" }),
                Responses.Authentication.usernameTooShort
            ]
        ])(
            "should return 400 for %s username",
            async (_: string, body: () => object, error: string): Promise<void> => {
                const usernameBefore: string = await ownUsername(renamedUser.cookie);

                const response: supertest.Response = await renameUser(renamedUser.id, body())
                    .expect("Content-Type", /json/)
                    .expect(400);

                expect(response.body).toEqual({ error });
                expect(await ownUsername(renamedUser.cookie)).toBe(usernameBefore);
            }
        );

        it.each([
            ["another user's username", (): string => otherUser.username],
            [
                "a case-only lookalike of another user's username",
                (): string => otherUser.username.toUpperCase()
            ],
            [
                "another user's username padded with whitespace",
                (): string => ` ${otherUser.username} `
            ]
        ])("should return 409 for %s", async (_: string, username: () => string): Promise<void> => {
            const usernameBefore: string = await ownUsername(renamedUser.cookie);

            const response: supertest.Response = await renameUser(renamedUser.id, {
                username: username()
            }).expect(409);

            expect(response.body).toEqual({ error: Responses.Authentication.usernameTaken });
            expect(await ownUsername(renamedUser.cookie)).toBe(usernameBefore);
            expect(await ownUsername(otherUser.cookie)).toBe(otherUser.username);
        });

        it("should rename a user to a case variant of their own username", async (): Promise<void> => {
            const username: string = renamedUser.username.toUpperCase();

            const response: supertest.Response = await renameUser(renamedUser.id, { username })
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual(expectedRename(renamedUser, username));
            expect(await ownUsername(renamedUser.cookie)).toBe(username);
        });

        it("should rename a user by an uppercase id to a case variant of their own username", async (): Promise<void> => {
            const username: string = upperIdUser.username.toUpperCase();

            const response: supertest.Response = await renameUser(upperIdUser.id.toUpperCase(), {
                username
            }).expect(200);

            expect(response.body).toEqual(expectedRename(upperIdUser, username));
            expect(await ownUsername(upperIdUser.cookie)).toBe(username);
        });

        it("should rename a user and return them in the admin shape", async (): Promise<void> => {
            const username: string = `${renamedUser.username}x`;

            const response: supertest.Response = await renameUser(renamedUser.id, { username })
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual(expectedRename(renamedUser, username));
        });

        it.each([
            ["an inner space", (): string => `Rv ${randomHex(5)}`],
            ["accents", (): string => `R\u00e9${randomHex(5)}\u00e1`],
            ["an emoji", (): string => `\u{1F600}${randomHex(5)}`],
            ["emoji presentation selectors", (): string => `❤\ufe0f❤\ufe0e${randomHex(5)}`]
        ])(
            "should rename a user to a username with %s",
            async (_: string, makeUsername: () => string): Promise<void> => {
                const username: string = makeUsername();

                const response: supertest.Response = await renameUser(charsetUser.id, {
                    username
                }).expect(200);

                expect(response.body).toEqual(expectedRename(charsetUser, username));
                expect(await ownUsername(charsetUser.cookie)).toBe(username);
            }
        );

        it("should store the username trimmed", async (): Promise<void> => {
            const username: string = `${renamedUser.username}w`;

            const response: supertest.Response = await renameUser(renamedUser.id, {
                username: ` ${username} `
            }).expect(200);

            expect(response.body.user.username).toBe(username);
            expect(await ownUsername(renamedUser.cookie)).toBe(username);
        });

        it("should never return authentication fields", async (): Promise<void> => {
            const response: supertest.Response = await renameUser(renamedUser.id, {
                username: `${renamedUser.username}y`
            }).expect(200);

            expect(Object.keys(response.body).sort()).toEqual(["message", "user"]);
            expect(Object.keys(response.body.user).sort()).toEqual([
                "createdAt",
                "email",
                "id",
                "isSuperuser",
                "suspendedAt",
                "uploads",
                "username"
            ]);
            expect(JSON.stringify(response.body)).not.toMatch(
                /authentication|password|salt|sessionToken|uploadQuotaBytes/
            );
        });

        it("should store the new username", async (): Promise<void> => {
            const username: string = `${renamedUser.username}z`;

            await renameUser(renamedUser.id, { username }).expect(200);

            const response: supertest.Response = await listUsers(`q=${username}`).expect(200);

            expect(response.body.users).toEqual([
                expectedAdminUser({ ...renamedUser, username }, 0, 0)
            ]);
            expect(await ownUsername(renamedUser.cookie)).toBe(username);
        });

        it("should still not let a user rename someone else with PATCH /users/:id", async (): Promise<void> => {
            const usernameBefore: string = await ownUsername(renamedUser.cookie);

            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/users/${renamedUser.id}`)
                .set("Cookie", outsider.cookie)
                .send({ username: `${outsider.username}x` })
                .expect(403);

            expect(response.body).toEqual({ error: Responses.notAuthorized });
            expect(await ownUsername(renamedUser.cookie)).toBe(usernameBefore);
        });
    });

    describe("PATCH /admin/users/:id/suspension", (): void => {
        let suspendUser: TestUser;
        let pendingUser: TestUser;
        let legacyUser: TestUser;
        let activeUser: TestUser;
        let suspendedAt: string;

        const updateSuspension = (
            id: string,
            body: object,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL)
                .patch(`/admin/users/${id}/suspension`)
                .set("Cookie", cookie)
                .send(body);

        const storedUser = async (id: string) =>
            UserModel.findById(id)
                .select(
                    "+authentication.sessionToken +authentication.passwordReset +authentication.passwordResetLinks"
                )
                .lean();

        const loginAs = (email: string, password: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/login")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email, password });

        const getOwnUser = (cookie: string): supertest.Test =>
            request(TestData.apiURL).get("/user").set("Cookie", cookie);

        const allowResend = (email: string): Promise<unknown> =>
            PendingRegistrationModel.updateOne(
                { email },
                { $set: { "code.sentAt": new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000) } }
            );

        beforeAll(async (): Promise<void> => {
            [suspendUser, pendingUser, legacyUser, activeUser] = await Promise.all([
                createTestUser("susp"),
                createTestUser("pend"),
                createTestUser("nosusp"),
                createTestUser("active")
            ]);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/admin/users/${suspendUser.id}/suspension`)
                .send({ suspended: true })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await updateSuspension(
                suspendUser.id,
                { suspended: true },
                suspendUser.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
            expect((await storedUser(suspendUser.id)).suspendedAt).toBeNull();
        });

        it("should return 400 for an invalid id", async (): Promise<void> => {
            const response: supertest.Response = await updateSuspension("invalid-id", {
                suspended: true
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for an unknown user", async (): Promise<void> => {
            const response: supertest.Response = await updateSuspension(
                new mongoose.Types.ObjectId().toString(),
                { suspended: true }
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });

        it.each([
            ["a missing", {}],
            ["a string", { suspended: "true" }],
            ["a number", { suspended: 1 }]
        ])("should return 400 for %s suspended", async (_: string, body: object) => {
            const response: supertest.Response = await updateSuspension(suspendUser.id, body)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.Admin.invalidSuspension });
            expect((await storedUser(suspendUser.id)).suspendedAt).toBeNull();
        });

        it("should refuse to suspend the superuser", async (): Promise<void> => {
            const response: supertest.Response = await updateSuspension(TestData.superuser.id, {
                suspended: true
            }).expect(409);

            expect(response.body).toEqual({ error: Responses.Admin.superuserSuspension });
            expect((await storedUser(TestData.superuser.id)).suspendedAt).toBeNull();
            await getOwnUser(TestData.superuser.cookie).expect(200);
        });

        it("should suspend the user and end their session", async (): Promise<void> => {
            const response: supertest.Response = await updateSuspension(suspendUser.id, {
                suspended: true
            })
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.userSuspendedSuccess,
                user: { ...expectedAdminUser(suspendUser, 0, 0), suspendedAt: expect.any(String) }
            });
            expect(Object.keys(response.body.user).sort()).toEqual([
                "createdAt",
                "email",
                "id",
                "isSuperuser",
                "suspendedAt",
                "uploads",
                "username"
            ]);
            expect(JSON.stringify(response.body)).not.toMatch(
                /authentication|password|salt|sessionToken/
            );

            suspendedAt = response.body.user.suspendedAt;
            expect(new Date(suspendedAt).toISOString()).toBe(suspendedAt);
            expect((await storedUser(suspendUser.id)).authentication?.sessionToken).toBeUndefined();

            const userResponse: supertest.Response = await getOwnUser(suspendUser.cookie).expect(
                403
            );
            expect(userResponse.body).toEqual({ error: Responses.notLoggedIn });
        });

        it("should keep the first suspendedAt when suspended again", async (): Promise<void> => {
            const response: supertest.Response = await updateSuspension(suspendUser.id, {
                suspended: true
            }).expect(200);

            expect(response.body.user.suspendedAt).toBe(suspendedAt);
        });

        it("should list suspendedAt in GET /admin/users", async (): Promise<void> => {
            const response: supertest.Response = await listUsers(
                `q=${suspendUser.username}`
            ).expect(200);

            expect(response.body.users).toEqual([
                { ...expectedAdminUser(suspendUser, 0, 0), suspendedAt }
            ]);
        });

        it("should reject a session stored for a suspended user", async (): Promise<void> => {
            const response: supertest.Response = await getOwnUser(
                await storeSession(suspendUser)
            ).expect(403);

            expect(response.body).toEqual({ error: Responses.notLoggedIn });
        });

        it("should answer the correct password with the suspended message", async (): Promise<void> => {
            const response: supertest.Response = await loginAs(
                suspendUser.email,
                suspendUser.password
            ).expect(403);

            expect(response.body).toEqual({ error: Responses.Authentication.accountSuspended });
            expect(response.headers["set-cookie"]).toBeUndefined();
        });

        it("should answer a wrong password with invalidCredentials", async (): Promise<void> => {
            const response: supertest.Response = await loginAs(
                suspendUser.email,
                randomHex(12)
            ).expect(403);

            expect(response.body).toEqual({ error: Responses.Authentication.invalidCredentials });
        });

        it("should issue no password reset", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/password-reset")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: suspendUser.email })
                .expect(200);

            expect(response.body).toEqual({ message: Responses.Authentication.passwordResetSent });

            const sendMail: jest.SpyInstance = jest.spyOn(mail, "sendMail").mockResolvedValue();

            try {
                expect(await runRequestReset(suspendUser.email)).toEqual({
                    status: 200,
                    body: { message: Responses.Authentication.passwordResetSent }
                });
                expect(sendMail).not.toHaveBeenCalled();
            } finally {
                sendMail.mockRestore();
            }

            const { authentication } = await storedUser(suspendUser.id);
            expect(authentication?.passwordReset).toBeUndefined();
            expect(authentication?.passwordResetLinks).toBeUndefined();
        });

        it("should store no password reset from a request that loaded the user before the suspension", async (): Promise<void> => {
            const resetCode = issueEmailCode(
                passwordResetScope(suspendUser.id, suspendUser.email),
                createEmailCode(),
                30
            );

            const previous = await setPasswordReset(
                suspendUser.id,
                suspendUser.email,
                resetCode,
                { hash: randomHex(32), expiresAt: resetCode.expiresAt },
                30,
                new Date()
            );

            expect(previous).toBeNull();
            const { authentication } = await storedUser(suspendUser.id);
            expect(authentication?.passwordReset).toBeUndefined();
            expect(authentication?.passwordResetLinks).toBeUndefined();
        });

        it("should resend no registration code and answer like any address", async (): Promise<void> => {
            const email: string = suspendUser.email;
            const resent = { message: Responses.Authentication.registrationCodeResent };
            await registerRequest({
                email,
                username: `s${randomHex(5)}`,
                password: randomHex(12)
            }).expect(202);

            const storedHash = async (): Promise<string> =>
                (await PendingRegistrationModel.findOne({ email }).lean()).code.hash;
            const sendMail: jest.SpyInstance = jest.spyOn(mail, "sendMail").mockResolvedValue();

            try {
                const registeredHash: string = await storedHash();
                expect(await runResendRegistration(email)).toEqual({ status: 200, body: resent });
                expect(await storedHash()).toBe(registeredHash);

                await allowResend(email);
                expect(await runResendRegistration(email)).toEqual({ status: 200, body: resent });
                expect(await storedHash()).not.toBe(registeredHash);
                expect(sendMail).not.toHaveBeenCalled();
            } finally {
                sendMail.mockRestore();
            }
        });

        it("should let the user log in again once unsuspended", async (): Promise<void> => {
            const suspendedSession: string = await storeSession(suspendUser);

            const response: supertest.Response = await updateSuspension(suspendUser.id, {
                suspended: false
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.userUnsuspendedSuccess,
                user: expectedAdminUser(suspendUser, 0, 0)
            });

            const loginResponse: supertest.Response = await loginAs(
                suspendUser.email,
                suspendUser.password
            ).expect(200);

            await getOwnUser(loginResponse.headers["set-cookie"][0]).expect(200);
            await getOwnUser(suspendedSession).expect(403);
        });

        it("should leave an active user alone when lifting a suspension they don't have", async (): Promise<void> => {
            await runRequestReset(activeUser.email);

            const response: supertest.Response = await updateSuspension(activeUser.id, {
                suspended: false
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.userUnsuspendedSuccess,
                user: expectedAdminUser(activeUser, 0, 0)
            });
            await getOwnUser(activeUser.cookie).expect(200);

            const { authentication } = await storedUser(activeUser.id);
            expect(authentication?.passwordReset).toBeDefined();
            expect(authentication?.passwordResetLinks).toHaveLength(1);
        });

        it("should keep the session of a user stored without suspendedAt", async (): Promise<void> => {
            await UserModel.collection.updateOne(
                { _id: new mongoose.Types.ObjectId(legacyUser.id) },
                { $unset: { suspendedAt: "" } }
            );

            await getOwnUser(legacyUser.cookie).expect(200);
            expect(
                await UserModel.collection.findOne({ email: legacyUser.email })
            ).not.toHaveProperty("suspendedAt");
        });

        it("should void a password reset and e-mail change started before the suspension", async (): Promise<void> => {
            await runRequestReset(pendingUser.email);
            const code: string = createEmailCode();
            const secret: string = createOauthSecret();
            await UserModel.updateOne(
                { _id: pendingUser.id },
                {
                    $set: {
                        "authentication.passwordReset.hash": hashEmailCode(
                            passwordResetScope(pendingUser.id, pendingUser.email),
                            code
                        )
                    },
                    $push: {
                        "authentication.passwordResetLinks": {
                            hash: authentication(passwordResetLinkScope(pendingUser.id), secret),
                            expiresAt: new Date(Date.now() + 30 * 60 * 1000)
                        }
                    }
                }
            );
            await request(TestData.apiURL)
                .patch("/user/email")
                .set("Cookie", pendingUser.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: testEmailOf(`n${randomHex(5)}`), password: pendingUser.password })
                .expect(202);
            const passwordBefore: string = (await storedAuthentication(pendingUser.id)).password;

            await updateSuspension(pendingUser.id, { suspended: true }).expect(200);

            const codeResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/password-reset/confirm")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: pendingUser.email, code, newPassword: randomHex(12) })
                .expect(400);
            expect(codeResponse.body).toEqual({ error: Responses.EmailCodes.invalidCode });

            const linkResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/password-reset/confirm-link")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ token: `${pendingUser.id}.${secret}`, newPassword: randomHex(12) })
                .expect(400);
            expect(linkResponse.body).toEqual({
                error: Responses.Authentication.invalidPasswordResetLink
            });

            const stored = await UserModel.findById(pendingUser.id)
                .select(
                    "+authentication.passwordReset +authentication.passwordResetLinks +authentication.emailChange"
                )
                .lean();
            expect(stored.authentication?.passwordReset).toBeUndefined();
            expect(stored.authentication?.passwordResetLinks).toBeUndefined();
            expect(stored.authentication?.emailChange).toBeUndefined();
            expect((await storedAuthentication(pendingUser.id)).password).toBe(passwordBefore);
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
        });

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
                uploads: [...uploads].reverse().map(sameUpload),
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

            expect(publicResponse.body.uploads).toEqual([uploads[1]].map(sameUpload));
            expect(publicResponse.body.pagination.total).toBe(1);

            const privateResponse: supertest.Response = await listUserUploads(
                owner.id,
                "visibility=private"
            ).expect(200);

            expect(privateResponse.body.uploads).toEqual([uploads[2], uploads[0]].map(sameUpload));
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

            expect(response.body.uploads).toEqual([uploads[1]].map(sameUpload));
            expect(response.body.pagination.total).toBe(1);
        });

        it("should page the result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listUserUploads(
                owner.id,
                "sortOrder=asc&limit=2&page=2"
            ).expect(200);

            expect(pageTwo.body).toEqual({
                user: { id: owner.id, username: owner.username },
                uploads: [uploads[2]].map(sameUpload),
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
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listUserUploads(owner.id, query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
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

    describe("GET /admin/uploads", (): void => {
        const marker: string = `${TestData.runId}${randomHex(4)}`;
        const uploads: any[] = [];
        let owner: TestUser;
        let otherOwner: TestUser;

        const listUploads = (
            query: string = "",
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).get(`/admin/uploads?${query}`).set("Cookie", cookie);

        const ownedBy = (upload: any, uploadOwner: TestUser) => ({
            ...upload,
            owner: { id: uploadOwner.id, username: uploadOwner.username }
        });

        const namesOf = (list: any[]): string[] =>
            list.map((upload: any): string => upload.originalFileName);

        beforeAll(async (): Promise<void> => {
            [owner, otherOwner] = await Promise.all([createTestUser("aup"), createTestUser("bup")]);

            uploads.push(ownedBy(await uploadAs(owner.cookie, `${marker}-b.png`), owner));

            const publicUpload: any = await uploadAs(owner.cookie, `${marker}-A.png`);
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/upload/${publicUpload.id}`)
                .set("Cookie", owner.cookie)
                .send({ visibility: "public" })
                .expect(200);

            uploads.push(ownedBy(response.body.upload, owner));
            uploads.push(ownedBy(await uploadAs(otherOwner.cookie, `${marker}-c.png`), otherOwner));
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/uploads")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await listUploads("", owner.cookie).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should list every user's uploads with their owner, newest first", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(`q=${marker}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                uploads: [...uploads].reverse().map(sameUpload),
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

        it("should not expose the owners' e-mail or authentication", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(`q=${marker}`).expect(200);

            response.body.uploads.forEach((upload: any): void => {
                expect(Object.keys(upload.owner).sort()).toEqual(["id", "username"]);
            });
            expect(response.text).not.toMatch(/"(email|authentication|password|salt|session\w*)"/i);
            expect(response.text).not.toContain(owner.email);
            expect(response.text).not.toContain(otherOwner.email);
        });

        it("should match q against the file name case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(`q=${marker}-a.PNG`).expect(200);

            expect(response.body.uploads).toEqual([uploads[1]].map(sameUpload));
            expect(response.body.pagination.total).toBe(1);
        });

        it("should match q against the owner's username case-insensitively", async (): Promise<void> => {
            const ownerResponse: supertest.Response = await listUploads(
                `q=${owner.username.toUpperCase()}`
            ).expect(200);

            expect(ownerResponse.body.uploads).toEqual([uploads[1], uploads[0]].map(sameUpload));
            expect(ownerResponse.body.pagination.total).toBe(2);

            const otherResponse: supertest.Response = await listUploads(
                `q=${otherOwner.username.toUpperCase()}`
            ).expect(200);

            expect(otherResponse.body.uploads).toEqual([uploads[2]].map(sameUpload));
            expect(otherResponse.body.pagination.total).toBe(1);
        });

        it("should filter by visibility", async (): Promise<void> => {
            const publicResponse: supertest.Response = await listUploads(
                `q=${marker}&visibility=public`
            ).expect(200);

            expect(publicResponse.body.uploads).toEqual([uploads[1]].map(sameUpload));
            expect(publicResponse.body.pagination.total).toBe(1);

            const privateResponse: supertest.Response = await listUploads(
                `q=${marker}&visibility=private`
            ).expect(200);

            expect(privateResponse.body.uploads).toEqual([uploads[2], uploads[0]].map(sameUpload));
            expect(privateResponse.body.pagination.total).toBe(2);
        });

        it("should sort by originalFileName case-insensitively", async (): Promise<void> => {
            const ascResponse: supertest.Response = await listUploads(
                `q=${marker}&sortBy=originalFileName&sortOrder=asc`
            ).expect(200);

            expect(namesOf(ascResponse.body.uploads)).toEqual([
                `${marker}-A.png`,
                `${marker}-b.png`,
                `${marker}-c.png`
            ]);
            expect(ascResponse.body.pagination).toMatchObject({
                sortBy: "originalFileName",
                sortOrder: "asc"
            });

            const descResponse: supertest.Response = await listUploads(
                `q=${marker}&sortBy=originalFileName&sortOrder=desc`
            ).expect(200);

            expect(namesOf(descResponse.body.uploads)).toEqual([
                `${marker}-c.png`,
                `${marker}-b.png`,
                `${marker}-A.png`
            ]);
        });

        it("should page the result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listUploads(
                `q=${marker}&sortOrder=asc&limit=2&page=2`
            ).expect(200);

            expect(pageTwo.body).toEqual({
                uploads: [uploads[2]].map(sameUpload),
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

        it("should answer owner null for an upload whose owner is gone", async (): Promise<void> => {
            const uploadId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
            const orphanName: string = `${TestData.runId}${randomHex(4)}-orphan.png`;

            await UserUploadsModel.create({
                _id: uploadId,
                originalFileName: orphanName,
                storedFileName: `${uploadId}.png`,
                filePath: `${uploadId}.png`,
                extension: ".png",
                fileSize: testPng.length,
                mimeType: "image/png",
                uploadedBy: new mongoose.Types.ObjectId()
            });

            try {
                const response: supertest.Response = await listUploads(`q=${orphanName}`).expect(
                    200
                );

                expect(response.body.uploads).toEqual([
                    expect.objectContaining({ id: uploadId.toString(), owner: null })
                ]);
            } finally {
                await UserUploadsModel.deleteOne({ _id: uploadId });
            }
        });

        it.each([
            ["limit", "limit=0"],
            ["limit", "limit=51"],
            ["limit", "limit=1&limit=2"],
            ["page", "page=0"],
            ["sortBy", "sortBy=addedOn"],
            ["sortOrder", "sortOrder=up"],
            ["visibility", "visibility=secret"],
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listUploads(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
        });
    });

    describe("GET /admin/short-urls", (): void => {
        const shortUrls: any[] = [];
        let linkOwner: TestUser;
        let goneOwner: TestUser;
        let orphanShortUrl: any;

        const listShortUrls = (
            query: string,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).get(`/admin/short-urls?${query}`).set("Cookie", cookie);

        const shortenAs = async (shortener: TestUser): Promise<any> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
                .set("Cookie", shortener.cookie)
                .send({ url: `https://${TestData.runId}-${randomHex(8)}.vb2007.test/` })
                .expect(201);

            const { shortenedUrl, originalUrl, addedOn } = response.body.data;

            return {
                shortenedUrl,
                originalUrl,
                addedOn,
                owner: { id: shortener.id, username: shortener.username }
            };
        };

        beforeAll(async (): Promise<void> => {
            linkOwner = await createTestUser("surl");

            for (let i = 0; i < 3; i++) {
                shortUrls.push(await shortenAs(linkOwner));
            }

            goneOwner = await createTestUser("gone");
            orphanShortUrl = await shortenAs(goneOwner);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/short-urls")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls("", linkOwner.cookie).expect(
                403
            );

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should list the short links with their owner, newest first", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(`q=${linkOwner.username}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                shortUrls: [...shortUrls].reverse(),
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 3,
                    pages: 1,
                    sortBy: "addedOn",
                    sortOrder: "desc"
                }
            });
        });

        it("should list a link whose owner is gone with a null owner", async (): Promise<void> => {
            await UserModel.deleteOne({ _id: goneOwner.id });

            try {
                const response: supertest.Response = await listShortUrls(
                    `q=${orphanShortUrl.shortenedUrl}`
                ).expect(200);

                expect(response.body.shortUrls).toContainEqual({ ...orphanShortUrl, owner: null });
            } finally {
                await ShortUrlModel.deleteOne({ shortenedUrl: orphanShortUrl.shortenedUrl });
            }
        });

        it("should never return authentication fields", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${linkOwner.username}`
            ).expect(200);

            for (const shortUrl of response.body.shortUrls) {
                expect(Object.keys(shortUrl).sort()).toEqual([
                    "addedOn",
                    "originalUrl",
                    "owner",
                    "shortenedUrl"
                ]);
                expect(Object.keys(shortUrl.owner).sort()).toEqual(["id", "username"]);
            }

            expect(JSON.stringify(response.body)).not.toMatch(
                /authentication|password|salt|sessionToken|email/
            );
        });

        it("should match q on the code case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${shortUrls[1].shortenedUrl.toUpperCase()}`
            ).expect(200);

            expect(response.body.shortUrls).toContainEqual(shortUrls[1]);
        });

        it("should match q on the target URL case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${new URL(shortUrls[2].originalUrl).hostname.toUpperCase()}`
            ).expect(200);

            expect(response.body.shortUrls).toEqual([shortUrls[2]]);
            expect(response.body.pagination.total).toBe(1);
        });

        it("should match q on the owner's username case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${linkOwner.username.toUpperCase()}`
            ).expect(200);

            expect(response.body.shortUrls).toEqual([...shortUrls].reverse());
        });

        it("should match regex characters in q literally", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${encodeURIComponent(`${linkOwner.username}.*`)}`
            ).expect(200);

            expect(response.body.shortUrls).toEqual([]);
            expect(response.body.pagination.total).toBe(0);
        });

        it("should sort by addedOn ascending", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${linkOwner.username}&sortBy=addedOn&sortOrder=asc`
            ).expect(200);

            expect(response.body.shortUrls).toEqual(shortUrls);
            expect(response.body.pagination).toMatchObject({
                sortBy: "addedOn",
                sortOrder: "asc"
            });
        });

        it("should page the filtered result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listShortUrls(
                `q=${linkOwner.username}&limit=2&page=2`
            ).expect(200);

            expect(pageTwo.body).toEqual({
                shortUrls: [shortUrls[0]],
                pagination: {
                    limit: 2,
                    page: 2,
                    total: 3,
                    pages: 2,
                    sortBy: "addedOn",
                    sortOrder: "desc"
                }
            });

            const pageThree: supertest.Response = await listShortUrls(
                `q=${linkOwner.username}&limit=2&page=3`
            ).expect(200);

            expect(pageThree.body.shortUrls).toEqual([]);
            expect(pageThree.body.pagination.total).toBe(3);
        });

        it.each([
            ["limit", "limit=0"],
            ["limit", "limit=51"],
            ["limit", "limit=abc"],
            ["limit", "limit=1&limit=2"],
            ["page", "page=0"],
            ["page", "page=9007199254740992"],
            ["sortBy", "sortBy=username"],
            ["sortOrder", "sortOrder=up"],
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=a&q=b"],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listShortUrls(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
        });
    });

    describe("toAdminShortUrl", (): void => {
        it("should return a null owner when the user is gone", (): void => {
            const addedOn: Date = new Date();

            expect(
                toAdminShortUrl({
                    shortenedUrl: "abc123",
                    originalUrl: "https://example.vb2007.test/",
                    addedOn,
                    addedBy: null
                })
            ).toEqual({
                shortenedUrl: "abc123",
                originalUrl: "https://example.vb2007.test/",
                addedOn,
                owner: null
            });
        });
    });

    describe("GET /admin/mail-budget", (): void => {
        const getMailBudget = (cookie: string = TestData.superuser.cookie): supertest.Test =>
            request(TestData.apiURL).get("/admin/mail-budget").set("Cookie", cookie);

        const nextUtcMidnight = (): number => new Date().setUTCHours(24, 0, 0, 0);

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/mail-budget")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await getMailBudget(user.cookie).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should return only today's mail budget", async (): Promise<void> => {
            const resetsAfter: number = nextUtcMidnight();
            const response: supertest.Response = await getMailBudget()
                .expect("Content-Type", /json/)
                .expect(200);
            const resetsBefore: number = nextUtcMidnight();

            const { dailyLimit } = response.body;

            expect(response.body).toEqual({
                sentToday: expect.any(Number),
                dailyLimit: expect.any(Number),
                warningAt: Math.ceil(dailyLimit * 0.8),
                registrationStopsAt: dailyLimit - Math.ceil(dailyLimit / 5),
                passwordResetStopsAt: dailyLimit - Math.ceil(dailyLimit / 10),
                resetsAt: expect.any(String)
            });
            expect(Number.isInteger(dailyLimit)).toBe(true);
            expect(dailyLimit).toBeGreaterThan(0);
            expect(Number.isInteger(response.body.sentToday)).toBe(true);
            expect(response.body.sentToday).toBeGreaterThanOrEqual(0);
            expect(new Date(response.body.resetsAt).toISOString()).toBe(response.body.resetsAt);
            expect(Date.parse(response.body.resetsAt)).toBeGreaterThanOrEqual(resetsAfter);
            expect(Date.parse(response.body.resetsAt)).toBeLessThanOrEqual(resetsBefore);
        });
    });

    describe("DELETE /admin/users/:id", (): void => {
        let deletedUser: TestUser;
        let upperCaseUser: TestUser;

        const deleteUser = (
            id: string,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).delete(`/admin/users/${id}`).set("Cookie", cookie);

        const uploadFolderOf = (folderUser: TestUser): string =>
            path.join(process.env.UPLOAD_DISK_DIRECTORY, folderUser.id);

        const contentOf = async (contentUser: TestUser) => ({
            pastes: await PastebinModel.countDocuments({ addedBy: contentUser.id }),
            shortUrls: await ShortUrlModel.countDocuments({ addedBy: contentUser.id }),
            uploads: await UserUploadsModel.countDocuments({ uploadedBy: contentUser.id }),
            uploadFolder: fs.existsSync(uploadFolderOf(contentUser))
        });

        beforeAll(async (): Promise<void> => {
            deletedUser = await createTestUser("adel");
            await addPasteAndShortUrl(deletedUser.cookie);
            await uploadAs(deletedUser.cookie, "deleted.png");
            upperCaseUser = await createTestUser("adelUp");
            await addPasteAndShortUrl(upperCaseUser.cookie);
            await uploadAs(upperCaseUser.cookie, "deleted.png");
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/admin/users/${deletedUser.id}`)
                .expect(403);

            expect(response.body).toEqual({ error: Responses.notLoggedIn });
            expect(await UserModel.exists({ _id: deletedUser.id })).toBeTruthy();
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await deleteUser(
                deletedUser.id,
                user.cookie
            ).expect(403);

            expect(response.body).toEqual({ error: Responses.notAuthorized });
            expect(await UserModel.exists({ _id: deletedUser.id })).toBeTruthy();
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            const response: supertest.Response = await deleteUser("not-an-id").expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for a non-existing user ID", async (): Promise<void> => {
            const response: supertest.Response = await deleteUser(
                new mongoose.Types.ObjectId().toString()
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });

        it("should refuse to delete the superuser's own account", async (): Promise<void> => {
            const response: supertest.Response = await deleteUser(TestData.superuser.id).expect(
                409
            );

            expect(response.body).toEqual({ error: Responses.Admin.cannotDeleteSuperuser });
            expect(await UserModel.exists({ _id: TestData.superuser.id })).toBeTruthy();
            await listUsers("limit=1").expect(200);
        });

        it("should delete the user with their pastes, short links and uploads", async (): Promise<void> => {
            expect(await contentOf(deletedUser)).toEqual({
                pastes: 1,
                shortUrls: 1,
                uploads: 1,
                uploadFolder: true
            });

            const response: supertest.Response = await deleteUser(deletedUser.id)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({ message: Responses.Admin.userDeletedSuccess });
            expect(await UserModel.exists({ _id: deletedUser.id })).toBeNull();
            expect(await contentOf(deletedUser)).toEqual({
                pastes: 0,
                shortUrls: 0,
                uploads: 0,
                uploadFolder: false
            });
        });

        it("should delete everything for an uppercase ID", async (): Promise<void> => {
            const response: supertest.Response = await deleteUser(
                upperCaseUser.id.toUpperCase()
            ).expect(200);

            expect(response.body).toEqual({ message: Responses.Admin.userDeletedSuccess });
            expect(await UserModel.exists({ _id: upperCaseUser.id })).toBeNull();
            expect(await contentOf(upperCaseUser)).toEqual({
                pastes: 0,
                shortUrls: 0,
                uploads: 0,
                uploadFolder: false
            });
        });

        it("should end the deleted user's session", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", deletedUser.cookie)
                .expect(403);

            expect(response.body).toEqual({ error: Responses.notLoggedIn });
        });

        it("should return 404 for a user who was already deleted", async (): Promise<void> => {
            const response: supertest.Response = await deleteUser(deletedUser.id).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });
    });

    describe("POST /admin/users/:id/logout", (): void => {
        let loggedIn: TestUser;
        let loggedOut: TestUser;

        const logoutUser = (
            id: string,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).post(`/admin/users/${id}/logout`).set("Cookie", cookie);

        const storedSession = async (id: string) =>
            (
                await UserModel.findById(id)
                    .select("+authentication.sessionToken +authentication.sessionExpiresAt")
                    .lean()
            ).authentication;

        beforeAll(async (): Promise<void> => {
            loggedIn = await createTestUser("lo");
            loggedOut = await createTestUser("lo");

            await request(TestData.apiURL)
                .post("/auth/logout")
                .set("Cookie", loggedOut.cookie)
                .expect(200);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post(`/admin/users/${loggedOut.id}/logout`)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await logoutUser(
                loggedOut.id,
                emptyUser.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should end the user's session", async (): Promise<void> => {
            await request(TestData.apiURL).get("/user").set("Cookie", loggedIn.cookie).expect(200);

            const response: supertest.Response = await logoutUser(loggedIn.id)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.userLoggedOutSuccess,
                user: { id: loggedIn.id, username: loggedIn.username }
            });
            expect(response.headers["set-cookie"]).toBeUndefined();

            const stored = await storedSession(loggedIn.id);
            expect(stored).not.toHaveProperty("sessionToken");
            expect(stored).not.toHaveProperty("sessionExpiresAt");

            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", loggedIn.cookie)
                .expect(403);

            expect(userResponse.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should answer 200 for a user without a session", async (): Promise<void> => {
            const response: supertest.Response = await logoutUser(loggedOut.id).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.userLoggedOutSuccess,
                user: { id: loggedOut.id, username: loggedOut.username }
            });
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            const response: supertest.Response = await logoutUser("not-an-id").expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for a non-existing user ID", async (): Promise<void> => {
            const response: supertest.Response = await logoutUser(
                new mongoose.Types.ObjectId().toString()
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
        });
    });

    describe("toUploadTotals", (): void => {
        it("should answer zeros without uploads", (): void => {
            expect(toUploadTotals([])).toEqual({ total: 0, public: 0, private: 0, storedBytes: 0 });
        });

        it("should add up both visibilities and default a missing one to zero", (): void => {
            expect(
                toUploadTotals([
                    { _id: "private", bytes: 300, count: 2 },
                    { _id: "public", bytes: 70, count: 1 }
                ])
            ).toEqual({ total: 3, public: 1, private: 2, storedBytes: 370 });

            expect(toUploadTotals([{ _id: "public", bytes: 0, count: 4 }])).toEqual({
                total: 4,
                public: 4,
                private: 0,
                storedBytes: 0
            });
        });
    });

    describe("GET /admin/stats", (): void => {
        let statsUser: TestUser;

        const getStats = (cookie: string = TestData.superuser.cookie): supertest.Test =>
            request(TestData.apiURL).get("/admin/stats").set("Cookie", cookie);

        beforeAll(async (): Promise<void> => {
            statsUser = await createTestUser("stats");

            await uploadAs(statsUser.cookie, "private.png");
            await uploadAs(statsUser.cookie, "public.png", "public");
            await addPasteAndShortUrl(statsUser.cookie);

            const pendingName: string = `stats${randomHex(5)}`;

            await registerRequest({
                username: pendingName,
                email: testEmailOf(pendingName),
                password: randomHex(12)
            }).expect(202);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/stats")
                .expect(403);

            expect(response.body).toEqual({ error: Responses.notLoggedIn });
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await getStats(statsUser.cookie).expect(403);

            expect(response.body).toEqual({ error: Responses.notAuthorized });
        });

        it("should return the site totals and upload settings", async (): Promise<void> => {
            const response: supertest.Response = await getStats()
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                users: expect.any(Number),
                pastes: expect.any(Number),
                shortUrls: expect.any(Number),
                uploads: {
                    total: expect.any(Number),
                    public: expect.any(Number),
                    private: expect.any(Number),
                    storedBytes: expect.any(Number)
                },
                pendingRegistrations: expect.any(Number),
                settings: { defaultUploadQuotaBytes, maxFileSizeBytes }
            });
        });

        it("should count every total as a non-negative integer", async (): Promise<void> => {
            const { body } = await getStats().expect(200);

            const counts: Record<string, unknown> = {
                users: body.users,
                pastes: body.pastes,
                shortUrls: body.shortUrls,
                "uploads.total": body.uploads.total,
                "uploads.public": body.uploads.public,
                "uploads.private": body.uploads.private,
                "uploads.storedBytes": body.uploads.storedBytes,
                pendingRegistrations: body.pendingRegistrations
            };

            const invalidFields: string[] = Object.keys(counts).filter(
                (field: string): boolean =>
                    !Number.isSafeInteger(counts[field]) || (counts[field] as number) < 0
            );

            expect(invalidFields).toEqual([]);
        });

        it("should count at least this test's own data", async (): Promise<void> => {
            const { body } = await getStats().expect(200);

            expect(body.users).toBeGreaterThanOrEqual(2);
            expect(body.pastes).toBeGreaterThanOrEqual(1);
            expect(body.shortUrls).toBeGreaterThanOrEqual(1);
            expect(body.uploads.public).toBeGreaterThanOrEqual(1);
            expect(body.uploads.private).toBeGreaterThanOrEqual(1);
            expect(body.uploads.total).toBe(body.uploads.public + body.uploads.private);
            expect(body.uploads.storedBytes).toBeGreaterThanOrEqual(2 * testPng.length);
            expect(body.pendingRegistrations).toBeGreaterThanOrEqual(1);
        });

        it("should not return auth or per-user fields", async (): Promise<void> => {
            const response: supertest.Response = await getStats().expect(200);

            ["authentication", "sessionToken", "password", "salt", "email", "username"].forEach(
                (field: string): void => {
                    expect(response.text).not.toContain(field);
                }
            );
        });
    });

    describe("DELETE /admin/rate-limits", (): void => {
        let ipUser: TestUser;
        let emailUser: TestUser;
        let lockedUser: TestUser;
        let allIpsUser: TestUser;
        let deviceUser: TestUser;
        let neighbourUser: TestUser;
        let accountUser: TestUser;
        let cappedUser: TestUser;
        let keptUser: TestUser;

        const clearRateLimits = (
            body: object,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).delete("/admin/rate-limits").set("Cookie", cookie).send(body);

        const loginFrom = (clientIp: string, email: string, password: string): supertest.Test =>
            request(TestData.apiURL)
                .post("/auth/login")
                .set("X-Forwarded-For", clientIp)
                .send({ email, password });

        const expectLockedOut = async (clientIp: string, lockedOutUser: TestUser) => {
            const response: supertest.Response = await loginFrom(
                clientIp,
                lockedOutUser.email,
                lockedOutUser.password
            ).expect(429);

            expect(response.body).toHaveProperty("error", Responses.tooManyFailedAttempts);
        };

        const lockOutFrom = async (clientIp: string, lockedOutUser: TestUser): Promise<string> => {
            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await loginFrom(clientIp, lockedOutUser.email, "wrong-password").expect(403);
            }

            await expectLockedOut(clientIp, lockedOutUser);

            return clientIp;
        };

        const lockOut = (lockedOutUser: TestUser): Promise<string> =>
            lockOutFrom(isolatedClientIp(), lockedOutUser);

        const failWithRememberedDevice = async (rememberingUser: TestUser): Promise<void> => {
            const loggedIn: supertest.Response = await loginFrom(
                isolatedClientIp(),
                rememberingUser.email,
                rememberingUser.password
            ).expect(200);
            const device: string = loggedIn
                .get("Set-Cookie")
                .find((cookie: string): boolean => cookie.startsWith(`${deviceCookie}=`))
                .split(";")[0];

            await loginFrom(isolatedClientIp(), rememberingUser.email, "wrong-password")
                .set("Cookie", device)
                .expect(403);
        };

        const changePassword = (
            user: TestUser,
            clientIp: string = isolatedClientIp()
        ): supertest.Test =>
            request(TestData.apiURL)
                .patch("/user/password")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", clientIp)
                .send({ currentPassword: "wrong-password", newPassword: randomHex(12) });

        const confirmEmail = (user: TestUser): supertest.Test =>
            request(TestData.apiURL)
                .post("/user/email/confirm")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ code: "123456" });

        const failuresOf = (count: number, hoursAgo: number): EmailCodeFailures => ({
            count,
            since: new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
        });

        const setCodeFailures = (user: TestUser, failures: Record<string, EmailCodeFailures>) =>
            UserModel.updateOne(
                { _id: user.id },
                {
                    $set: Object.fromEntries(
                        Object.entries(failures).map(([field, value]) => [
                            `authentication.${field}`,
                            value
                        ])
                    )
                }
            );

        const storedCodeFailures = async (user: TestUser) =>
            (
                await UserModel.findById(user.id)
                    .select(
                        "+authentication.passwordResetFailures +authentication.emailChangeFailures"
                    )
                    .lean()
            ).authentication;

        beforeAll(async (): Promise<void> => {
            [
                ipUser,
                emailUser,
                lockedUser,
                allIpsUser,
                deviceUser,
                neighbourUser,
                accountUser,
                cappedUser,
                keptUser
            ] = await Promise.all([
                createTestUser("rlip"),
                createTestUser("rlmail"),
                createTestUser("rlock"),
                createTestUser("rlall"),
                createTestUser("rldev"),
                createTestUser("rlnext"),
                createTestUser("rlacct"),
                createTestUser("rlcap"),
                createTestUser("rlkeep")
            ]);
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .send({ ip: isolatedClientIp() })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await clearRateLimits(
                { email: ipUser.email },
                ipUser.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it.each([
            ["no email or ip", {}, Responses.Admin.rateLimitTargetMissing],
            ["an empty email", { email: "" }, Responses.Admin.invalidRateLimitEmail],
            ["a whitespace-only email", { email: "   " }, Responses.Admin.invalidRateLimitEmail],
            ["an email that isn't a string", { email: 5 }, Responses.Admin.invalidRateLimitEmail],
            ["a null email", { email: null }, Responses.Admin.invalidRateLimitEmail],
            ["an ip that isn't an IP", { ip: "not-an-ip" }, Responses.Admin.invalidRateLimitIp],
            ["an out-of-range IPv4", { ip: "256.0.0.1" }, Responses.Admin.invalidRateLimitIp],
            ["an ip in an array", { ip: ["127.0.0.1"] }, Responses.Admin.invalidRateLimitIp],
            [
                "a valid email with an invalid ip",
                { email: "someone@example.com", ip: "1.2.3" },
                Responses.Admin.invalidRateLimitIp
            ]
        ])("should return 400 for %s", async (_: string, body: object, error: string) => {
            const response: supertest.Response = await clearRateLimits(body)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error });
        });

        it("should clear nothing for an address and IP without a counter", async (): Promise<void> => {
            const response: supertest.Response = await clearRateLimits({
                email: testEmailOf(`rl${randomHex(5)}`),
                ip: isolatedClientIp()
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.rateLimitsCleared,
                cleared: []
            });
        });

        it("should clear only the IP-keyed limiters for an ip", async (): Promise<void> => {
            const clientIp: string = await lockOut(ipUser);

            const response: supertest.Response = await clearRateLimits({ ip: clientIp }).expect(
                200
            );

            expect(response.body).toEqual({
                message: Responses.Admin.rateLimitsCleared,
                cleared: ["loginPerIp"]
            });
            await expectLockedOut(clientIp, ipUser);
        });

        it("should clear an IPv6 client's whole /56 for the IP-keyed limiters", async (): Promise<void> => {
            const subnet: string = `2001:db8:${randomHex(2)}`;

            await loginFrom(`${subnet}:1200::1`, ipUser.email, "wrong-password").expect(403);

            const otherSubnet: supertest.Response = await clearRateLimits({
                ip: `${subnet}:1300::1`
            }).expect(200);
            const sameSubnet: supertest.Response = await clearRateLimits({
                ip: `${subnet}:12ff::2`
            }).expect(200);

            expect(otherSubnet.body.cleared).toEqual([]);
            expect(sameSubnet.body.cleared).toEqual(["loginPerIp"]);
        });

        it("should clear the address's limiters, per-IP keys included, for an email", async (): Promise<void> => {
            const clientIp: string = await lockOut(emailUser);

            const response: supertest.Response = await clearRateLimits({
                email: emailUser.email
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.rateLimitsCleared,
                cleared: ["loginPerAccount", "loginPerEmail"]
            });
            await loginFrom(clientIp, emailUser.email, emailUser.password).expect(200);
        });

        it("should clear the address's lockouts from every IP and leave other addresses alone", async (): Promise<void> => {
            const [firstIp, secondIp]: string[] = [isolatedClientIp(), isolatedClientIp()];
            await lockOutFrom(firstIp, allIpsUser);
            await lockOutFrom(secondIp, allIpsUser);
            await lockOutFrom(firstIp, neighbourUser);

            const response: supertest.Response = await clearRateLimits({
                email: allIpsUser.email
            }).expect(200);

            expect(response.body.cleared).toEqual(["loginPerAccount", "loginPerEmail"]);
            await loginFrom(firstIp, allIpsUser.email, allIpsUser.password).expect(200);
            await loginFrom(secondIp, allIpsUser.email, allIpsUser.password).expect(200);
            await expectLockedOut(firstIp, neighbourUser);
        });

        it("should clear the counters of a remembered device for an email", async (): Promise<void> => {
            await failWithRememberedDevice(deviceUser);

            const response: supertest.Response = await clearRateLimits({
                email: deviceUser.email
            }).expect(200);

            expect(response.body.cleared).toEqual(["loginPerAccount", "loginPerEmail"]);
        });

        it("should clear the counters of a remembered device for an email with another IP", async (): Promise<void> => {
            await failWithRememberedDevice(deviceUser);

            const response: supertest.Response = await clearRateLimits({
                email: deviceUser.email,
                ip: isolatedClientIp()
            }).expect(200);

            expect(response.body.cleared).toEqual(["loginPerEmail"]);
        });

        it("should clear a lockout for an address from an IP", async (): Promise<void> => {
            const clientIp: string = await lockOut(lockedUser);

            const response: supertest.Response = await clearRateLimits({
                email: ` ${lockedUser.email.toUpperCase()} `,
                ip: clientIp
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.rateLimitsCleared,
                cleared: ["loginPerIp", "loginPerAccount", "loginPerEmail"]
            });
            expect(JSON.stringify(response.body)).not.toMatch(
                /authentication|password|salt|sessionToken/
            );

            await loginFrom(clientIp, lockedUser.email, "wrong-password").expect(403);
            await loginFrom(clientIp, lockedUser.email, lockedUser.password).expect(200);
        });

        it("should leave the address's lockouts from other IPs when given an ip too", async (): Promise<void> => {
            const [firstIp, secondIp]: string[] = [isolatedClientIp(), isolatedClientIp()];
            await lockOutFrom(firstIp, neighbourUser);
            await lockOutFrom(secondIp, neighbourUser);

            const response: supertest.Response = await clearRateLimits({
                email: neighbourUser.email,
                ip: firstIp
            }).expect(200);

            expect(response.body.cleared).toEqual([
                "loginPerIp",
                "loginPerAccount",
                "loginPerEmail"
            ]);
            await loginFrom(firstIp, neighbourUser.email, neighbourUser.password).expect(200);
            await expectLockedOut(secondIp, neighbourUser);
        });

        it("should clear the account's own limiters of the logged-in routes for an email", async (): Promise<void> => {
            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await changePassword(accountUser).expect(403);
                await confirmEmail(accountUser).expect(400);
            }
            await changePassword(accountUser).expect(429);
            await confirmEmail(accountUser).expect(429);

            const response: supertest.Response = await clearRateLimits({
                email: accountUser.email
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.rateLimitsCleared,
                cleared: [
                    "accountCodeChecksPerAccount",
                    "passwordChecksPerAccount",
                    "emailChangeCodeFailures"
                ]
            });
            await changePassword(accountUser).expect(403);
            await confirmEmail(accountUser).expect(400);
        });

        it("should reset the account's daily wrong-code caps for an email, naming the ones still counting", async (): Promise<void> => {
            await setCodeFailures(cappedUser, {
                passwordResetFailures: failuresOf(CODE_FAILURES_PER_DAY, 1),
                emailChangeFailures: failuresOf(3, 25)
            });

            const response: supertest.Response = await clearRateLimits({
                email: ` ${cappedUser.email.toUpperCase()} `
            }).expect(200);

            expect(response.body.cleared).toEqual(["passwordResetCodeFailures"]);
            const failures = await storedCodeFailures(cappedUser);
            expect(failures.passwordResetFailures).toBeUndefined();
            expect(failures.emailChangeFailures).toBeUndefined();
        });

        it("should reset a waiting registration's daily wrong-code cap for an email", async (): Promise<void> => {
            const email: string = testEmailOf(`rl${randomHex(5)}`);
            await PendingRegistrationModel.create({
                email,
                code: issueEmailCode(registrationCodeScope(email), createEmailCode(), 15),
                failures: failuresOf(CODE_FAILURES_PER_DAY, 1),
                expiresAt: new Date(Date.now() + 60 * 60 * 1000)
            });

            const response: supertest.Response = await clearRateLimits({ email }).expect(200);

            expect(response.body.cleared).toEqual(["registrationCodeFailures"]);
            expect(
                (await PendingRegistrationModel.findOne({ email }).lean()).failures
            ).toBeUndefined();
        });

        it("should leave the account's own limiters and daily caps alone for an ip", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();
            const passwordResetFailures: EmailCodeFailures = failuresOf(CODE_FAILURES_PER_DAY, 1);
            await setCodeFailures(keptUser, { passwordResetFailures });

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await changePassword(keptUser, clientIp).expect(403);
            }

            const response: supertest.Response = await clearRateLimits({ ip: clientIp }).expect(
                200
            );

            expect(response.body.cleared).toEqual(["passwordChecksPerIp"]);
            await changePassword(keptUser).expect(429);
            expect((await storedCodeFailures(keptUser)).passwordResetFailures).toEqual(
                passwordResetFailures
            );
        });
    });

    describe("GET /admin/pastes", (): void => {
        const pastePrefix: string = `p${randomHex(6)}`;
        const language: string = `k${randomHex(5)}+c`;
        const orphanLanguage: string = `o${randomHex(5)}`;
        const orphanId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
        const longContent: string = "ő".repeat(60) + "😀".repeat(60);
        const pastes: any[] = [];
        let pasteOwner: TestUser;
        let otherOwner: TestUser;

        const listPastes = (
            query: string,
            cookie: string = TestData.superuser.cookie
        ): supertest.Test =>
            request(TestData.apiURL).get(`/admin/pastes?${query}`).set("Cookie", cookie);

        const pasteAs = async (cookie: string, body: object): Promise<any> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .set("Cookie", cookie)
                .send(body)
                .expect(201);

            return response.body.paste;
        };

        const expectedAdminPaste = (index: number) => {
            const paste: any = pastes[index];
            const owner: TestUser = paste.addedBy === pasteOwner.id ? pasteOwner : otherOwner;

            return {
                id: paste._id,
                language: paste.language ?? null,
                preview: Array.from(paste.content).slice(0, PASTE_PREVIEW_LENGTH).join(""),
                addedOn: paste.addedOn,
                owner: { id: owner.id, username: owner.username }
            };
        };

        const idsOf = (list: any[]): string[] => list.map((paste: any): string => paste.id);

        const pasteIds = (...indexes: number[]): string[] =>
            indexes.map((index: number): string => pastes[index]._id);

        beforeAll(async (): Promise<void> => {
            pasteOwner = await registerTestUser(`${pastePrefix}a`);
            otherOwner = await registerTestUser(`${pastePrefix}b`);

            pastes.push(
                await pasteAs(pasteOwner.cookie, { paste: longContent, language: "typescript" })
            );
            pastes.push(
                await pasteAs(otherOwner.cookie, { paste: `other ${randomHex(4)}`, language })
            );
            pastes.push(await pasteAs(pasteOwner.cookie, { paste: `plain ${randomHex(4)}` }));

            await PastebinModel.collection.insertOne({
                _id: orphanId,
                content: `orphan ${randomHex(4)}`,
                language: orphanLanguage,
                addedBy: new mongoose.Types.ObjectId(),
                addedOn: new Date()
            });
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/pastes")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await listPastes("", pasteOwner.cookie).expect(
                403
            );

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should list the pastes with their owners, newest first", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(`q=${pastePrefix}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                pastes: [expectedAdminPaste(2), expectedAdminPaste(1), expectedAdminPaste(0)],
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 3,
                    pages: 1,
                    sortBy: "addedOn",
                    sortOrder: "desc"
                }
            });
        });

        it("should truncate the preview of a long paste", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(
                `q=${pastePrefix}&sortOrder=asc&limit=1`
            ).expect(200);

            const { preview } = response.body.pastes[0];

            expect(preview).toBe("ő".repeat(60) + "😀".repeat(PASTE_PREVIEW_LENGTH - 60));
            expect(Array.from(preview)).toHaveLength(PASTE_PREVIEW_LENGTH);
        });

        it("should never return the content, e-mails or authentication fields", async (): Promise<void> => {
            for (const query of [`q=${pastePrefix}`, "q=&limit=50"]) {
                const response: supertest.Response = await listPastes(query).expect(200);

                expect(response.body.pastes.length).toBeGreaterThan(0);

                for (const paste of response.body.pastes) {
                    expect(Object.keys(paste).sort()).toEqual([
                        "addedOn",
                        "id",
                        "language",
                        "owner",
                        "preview"
                    ]);

                    if (paste.owner) {
                        expect(Object.keys(paste.owner).sort()).toEqual(["id", "username"]);
                    }
                }
            }

            const response: supertest.Response = await listPastes(`q=${pastePrefix}`).expect(200);

            expect(JSON.stringify(response.body)).not.toMatch(
                /content|addedBy|email|authentication|password|salt|sessionToken/
            );
            expect(JSON.stringify(response.body)).not.toContain(pasteOwner.email);
        });

        it("should match q against the owner's username case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(
                `q=${pastePrefix.toUpperCase()}A`
            ).expect(200);

            expect(idsOf(response.body.pastes)).toEqual(pasteIds(2, 0));
            expect(response.body.pagination.total).toBe(2);
        });

        it("should match q against the language case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(
                `q=${encodeURIComponent(language.toUpperCase())}`
            ).expect(200);

            expect(response.body.pastes).toEqual([expectedAdminPaste(1)]);
            expect(response.body.pagination.total).toBe(1);
        });

        it("should match regex characters in q literally", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(
                `q=${encodeURIComponent(`${pastePrefix}.`)}`
            ).expect(200);

            expect(response.body.pastes).toEqual([]);
            expect(response.body.pagination.total).toBe(0);
        });

        it("should sort by addedOn ascending", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(
                `q=${pastePrefix}&sortBy=addedOn&sortOrder=asc`
            ).expect(200);

            expect(idsOf(response.body.pastes)).toEqual(pasteIds(0, 1, 2));
            expect(response.body.pagination).toMatchObject({
                sortBy: "addedOn",
                sortOrder: "asc"
            });
        });

        it("should page the filtered result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listPastes(
                `q=${pastePrefix}&limit=1&page=2`
            ).expect(200);

            expect(pageTwo.body).toEqual({
                pastes: [expectedAdminPaste(1)],
                pagination: {
                    limit: 1,
                    page: 2,
                    total: 3,
                    pages: 3,
                    sortBy: "addedOn",
                    sortOrder: "desc"
                }
            });

            const pageFour: supertest.Response = await listPastes(
                `q=${pastePrefix}&limit=1&page=4`
            ).expect(200);

            expect(pageFour.body.pastes).toEqual([]);
            expect(pageFour.body.pagination.total).toBe(3);
        });

        it("should list a paste whose owner no longer exists until it's deleted", async (): Promise<void> => {
            const response: supertest.Response = await listPastes(`q=${orphanLanguage}`).expect(
                200
            );

            expect(response.body.pastes).toEqual([
                {
                    id: orphanId.toString(),
                    language: orphanLanguage,
                    preview: expect.stringMatching(/^orphan /),
                    addedOn: expect.any(String),
                    owner: null
                }
            ]);

            await request(TestData.apiURL)
                .delete(`/paste/${orphanId}`)
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);

            const afterDelete: supertest.Response = await listPastes(`q=${orphanLanguage}`).expect(
                200
            );

            expect(afterDelete.body.pastes).toEqual([]);
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
            ["sortBy", "sortBy=username"],
            ["sortOrder", "sortOrder=up"],
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=a&q=b"],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listPastes(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
        });
    });
});

describe("Admin pending registrations API Tests", (): void => {
    const prefix: string = `p${randomHex(6)}`;
    const emails: string[] = ["a", "b", "c"].map((suffix: string) =>
        testEmailOf(`${prefix}${suffix}`)
    );
    const removableEmail: string = testEmailOf(`r${randomHex(6)}`);
    let expected: any[];
    let removableId: string;
    let user: TestUser;

    const startRegistration = async (email: string): Promise<void> => {
        await registerRequest({
            username: `r${randomHex(5)}`,
            email,
            password: randomHex(12)
        }).expect(202);
    };

    const pendingOf = async (email: string) =>
        PendingRegistrationModel.findOne({ email }).select("email expiresAt").lean();

    const listPending = (
        query: string,
        cookie: string = TestData.superuser.cookie
    ): supertest.Test =>
        request(TestData.apiURL).get(`/admin/pending-registrations?${query}`).set("Cookie", cookie);

    const removePending = (
        id: string,
        cookie: string = TestData.superuser.cookie
    ): supertest.Test =>
        request(TestData.apiURL).delete(`/admin/pending-registrations/${id}`).set("Cookie", cookie);

    const emailsOf = (list: any[]): string[] => list.map((pending: any): string => pending.email);

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("pr");

        for (const email of [...emails, removableEmail]) {
            await startRegistration(email);
        }

        expected = [];
        for (const email of [...emails].reverse()) {
            const pending = await pendingOf(email);
            expected.push({
                id: pending._id.toString(),
                email: pending.email,
                expiresAt: pending.expiresAt.toISOString()
            });
        }

        removableId = (await pendingOf(removableEmail))._id.toString();
    });

    describe("GET /admin/pending-registrations", (): void => {
        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/admin/pending-registrations")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await listPending("", user.cookie).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should list the pending registrations, newest first", async (): Promise<void> => {
            const response: supertest.Response = await listPending(`q=${prefix}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                pendingRegistrations: expected,
                pagination: { limit: 20, page: 1, total: 3, pages: 1 }
            });
        });

        it("should never return the code or its failures", async (): Promise<void> => {
            const response: supertest.Response = await listPending(`q=${prefix}`).expect(200);

            for (const pending of response.body.pendingRegistrations) {
                expect(Object.keys(pending).sort()).toEqual(["email", "expiresAt", "id"]);
            }

            expect(JSON.stringify(response.body)).not.toMatch(
                /"(code|failures|hash|attempts|sentAt|username|authentication)"/
            );
        });

        it("should match q case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listPending(
                `q=${prefix.toUpperCase()}A`
            ).expect(200);

            expect(emailsOf(response.body.pendingRegistrations)).toEqual([emails[0]]);
        });

        it("should match regex characters in q literally", async (): Promise<void> => {
            const response: supertest.Response = await listPending(
                `q=${encodeURIComponent(`${prefix}.`)}`
            ).expect(200);

            expect(response.body.pendingRegistrations).toEqual([]);
            expect(response.body.pagination.total).toBe(0);
        });

        it("should page the filtered result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listPending(
                `q=${prefix}&limit=1&page=2`
            ).expect(200);

            expect(pageTwo.body).toEqual({
                pendingRegistrations: [expected[1]],
                pagination: { limit: 1, page: 2, total: 3, pages: 3 }
            });

            const pageFour: supertest.Response = await listPending(
                `q=${prefix}&limit=1&page=4`
            ).expect(200);

            expect(pageFour.body.pendingRegistrations).toEqual([]);
            expect(pageFour.body.pagination.total).toBe(3);
        });

        it("should return an empty page for the largest page number", async (): Promise<void> => {
            const response: supertest.Response = await listPending(
                `q=${prefix}&limit=50&page=${Number.MAX_SAFE_INTEGER}`
            ).expect(200);

            expect(response.body).toEqual({
                pendingRegistrations: [],
                pagination: { limit: 50, page: Number.MAX_SAFE_INTEGER, total: 3, pages: 1 }
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
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=a&q=b"],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listPending(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
        });
    });

    describe("DELETE /admin/pending-registrations/:id", (): void => {
        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/admin/pending-registrations/${removableId}`)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
            expect(await pendingOf(removableEmail)).not.toBeNull();
        });

        it("should reject a user who isn't the superuser", async (): Promise<void> => {
            const response: supertest.Response = await removePending(
                removableId,
                user.cookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
            expect(await pendingOf(removableEmail)).not.toBeNull();
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            const response: supertest.Response = await removePending("not-an-id").expect(400);

            expect(response.body).toEqual({ error: Responses.Mongoose.invalidIdFormat });
        });

        it("should return 404 for a non-existing ID", async (): Promise<void> => {
            const response: supertest.Response = await removePending(
                new mongoose.Types.ObjectId().toString()
            ).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.pendingRegistrationNotFound });
        });

        it("should remove the pending registration", async (): Promise<void> => {
            const response: supertest.Response = await removePending(removableId)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                message: Responses.Admin.pendingRegistrationRemovedSuccess
            });
            expect(await PendingRegistrationModel.findById(removableId).lean()).toBeNull();

            const listResponse: supertest.Response = await listPending(
                `q=${encodeURIComponent(removableEmail)}`
            ).expect(200);

            expect(listResponse.body.pendingRegistrations).toEqual([]);
        });

        it("should return 404 when removing it again", async (): Promise<void> => {
            const response: supertest.Response = await removePending(removableId).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.pendingRegistrationNotFound });
        });

        it("should let the address start registering again", async (): Promise<void> => {
            await startRegistration(removableEmail);

            const relisted: supertest.Response = await listPending(
                `q=${encodeURIComponent(removableEmail)}`
            ).expect(200);

            expect(emailsOf(relisted.body.pendingRegistrations)).toEqual([removableEmail]);
            expect(relisted.body.pendingRegistrations[0].id).not.toBe(removableId);
        });

        it("should leave the other pending registrations alone", async (): Promise<void> => {
            const response: supertest.Response = await listPending(`q=${prefix}`).expect(200);

            expect(response.body.pendingRegistrations).toEqual(expected);
        });
    });

    describe("expired pending registrations", (): void => {
        const expiryPrefix: string = `x${randomHex(6)}`;
        const liveEmail: string = testEmailOf(`${expiryPrefix}a`);
        const expiredEmail: string = testEmailOf(`${expiryPrefix}b`);
        let expiredId: string;

        beforeAll(async (): Promise<void> => {
            await startRegistration(liveEmail);
            await startRegistration(expiredEmail);

            expiredId = (await pendingOf(expiredEmail))._id.toString();

            await PendingRegistrationModel.updateOne(
                { email: expiredEmail },
                { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } }
            );
        });

        it("should leave them out of the list and its total", async (): Promise<void> => {
            const response: supertest.Response = await listPending(`q=${expiryPrefix}`).expect(200);

            expect(emailsOf(response.body.pendingRegistrations)).toEqual([liveEmail]);
            expect(response.body.pagination.total).toBe(1);

            const expiredOnly: supertest.Response = await listPending(
                `q=${encodeURIComponent(expiredEmail)}`
            ).expect(200);

            expect(expiredOnly.body).toEqual({
                pendingRegistrations: [],
                pagination: { limit: 20, page: 1, total: 0, pages: 0 }
            });
        });

        it("should return 404 when removing one", async (): Promise<void> => {
            const response: supertest.Response = await removePending(expiredId).expect(404);

            expect(response.body).toEqual({ error: Responses.Admin.pendingRegistrationNotFound });
        });
    });

    describe("DELETE /admin/pending-registrations/:id during a verification", (): void => {
        const raceEmails: string[] = ["a", "b", "c"].map((suffix: string) =>
            testEmailOf(`w${randomHex(6)}${suffix}`)
        );
        const codes: Record<string, string> = {};

        const verifyInProcess = async (email: string, next: jest.Mock = jest.fn()) => {
            const res: any = { locals: {} };
            for (const method of ["status", "json", "set", "cookie"]) {
                res[method] = jest.fn().mockReturnValue(res);
            }

            await verifyRegistrationHandler(
                {
                    body: {
                        email,
                        code: codes[email],
                        username: `v${randomHex(5)}`,
                        password: randomHex(12)
                    }
                } as express.Request,
                res,
                next
            );

            return res;
        };

        const idOf = async (email: string): Promise<string> =>
            (await pendingOf(email))._id.toString();

        beforeAll(async (): Promise<void> => {
            for (const email of raceEmails) {
                await startRegistration(email);
                codes[email] = await setRegistrationCode(email);
            }
        });

        afterEach((): void => {
            jest.restoreAllMocks();
        });

        it("should fail the verification when the delete lands first", async (): Promise<void> => {
            const email: string = raceEmails[0];
            const id: string = await idOf(email);
            const hashPassword = password.hashPassword;
            let deleteStatus: number;

            jest.spyOn(password, "hashPassword").mockImplementation(
                async (salt: string, plain: string, client: string): Promise<string> => {
                    deleteStatus = (await removePending(id)).status;
                    return hashPassword(salt, plain, client);
                }
            );

            const res = await verifyInProcess(email);

            expect(deleteStatus).toBe(200);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: Responses.EmailCodes.invalidCode });
            expect(await UserModel.exists({ email })).toBeNull();
        });

        it("should answer 404 to a delete that lands after the verification took it", async (): Promise<void> => {
            const email: string = raceEmails[1];
            const id: string = await idOf(email);
            const createUser = usersDatabase.createUser;
            let deleteStatus: number;

            jest.spyOn(usersDatabase, "createUser").mockImplementation(
                async (values: Record<string, any>) => {
                    deleteStatus = (await removePending(id)).status;
                    return createUser(values);
                }
            );

            const res = await verifyInProcess(email);

            expect(deleteStatus).toBe(404);
            expect(res.status).toHaveBeenCalledWith(201);
            expect(await UserModel.exists({ email })).not.toBeNull();
            expect(await pendingOf(email)).toBeNull();
        });

        it("should put the pending registration back when the account can't be created", async (): Promise<void> => {
            const email: string = raceEmails[2];
            const before = await PendingRegistrationModel.findOne({ email }).lean();
            const error: Error = new Error("write failed");
            const next: jest.Mock = jest.fn();

            jest.spyOn(usersDatabase, "createUser").mockRejectedValue(error);

            await verifyInProcess(email, next);

            expect(next).toHaveBeenCalledWith(error);
            expect(await PendingRegistrationModel.findOne({ email }).lean()).toMatchObject({
                _id: before._id,
                email,
                code: { hash: before.code.hash, attempts: before.code.attempts + 1 },
                expiresAt: before.expiresAt
            });

            jest.restoreAllMocks();
            await verifyRegistration(email, codes[email]).expect(201);
        });
    });
});
