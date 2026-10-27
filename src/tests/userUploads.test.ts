import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import http from "http";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { maxFileSizeBytes } from "../helpers/multer";
import { defaultUploadQuotaBytes } from "../helpers/uploadQuota";
import { ALLOWED_UPLOAD_TYPES, UPLOAD_CATEGORIES } from "../constants/uploads";
import { UserModel } from "../database/users";
import { UserUploadsModel } from "../database/userUploads";
import { TestUser, createTestUser, randomHex } from "./helpers/testUsers";

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const testJpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const expectUploadResponse = (
    upload: any,
    userId: string,
    fileName: string,
    ext: string,
    visibility: string = "private"
): void => {
    expect(upload).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{24}$/),
        originalFileName: fileName,
        extension: ext,
        mimeType: "image/png",
        fileSize: testPng.length,
        visibility,
        url: `${process.env.CDN_URL}/useruploads/${userId}/${upload.id}${ext}`,
        uploadedOn: expect.any(String),
        updatedOn: expect.any(String)
    });
    expect(new Date(upload.uploadedOn).toISOString()).toBe(upload.uploadedOn);
    expect(new Date(upload.updatedOn).toISOString()).toBe(upload.updatedOn);
};

const uploadDiskPathOf = (userId: string, upload: any): string =>
    path.join(process.env.UPLOAD_DISK_DIRECTORY, userId, `${upload.id}${upload.extension}`);

const listUserUploadDir = (userId: string): string[] => {
    const userUploadDir: string = path.join(process.env.UPLOAD_DISK_DIRECTORY, userId);
    return fs.existsSync(userUploadDir) ? fs.readdirSync(userUploadDir).sort() : [];
};

describe("User Uploads API Tests", (): void => {
    let authCookie: string;
    let userId: string;
    let otherCookie: string;
    let otherUserId: string;
    let uploadId: string;
    let uploadDiskPath: string;

    beforeAll(async (): Promise<void> => {
        const owner: TestUser = await createTestUser();
        authCookie = owner.cookie;
        userId = owner.id;

        const other: TestUser = await createTestUser();
        otherCookie = other.cookie;
        otherUserId = other.id;

        const uploadResponse: supertest.Response = await request(TestData.apiURL)
            .post("/upload")
            .set("Cookie", authCookie)
            .attach("file", testPng, "test.png");

        expect(uploadResponse.status).toBe(201);

        uploadId = uploadResponse.body.upload.id;
        uploadDiskPath = uploadDiskPathOf(userId, uploadResponse.body.upload);
    }, 25000);

    afterAll(async (): Promise<void> => {
        if (uploadId) {
            await request(TestData.apiURL).delete(`/upload/${uploadId}`).set("Cookie", authCookie);
        }
    });

    describe("GET /upload/:id", (): void => {
        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${uploadId}`)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should not return another user's upload", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${uploadId}`)
                .set("Cookie", otherCookie)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/upload/abc")
                .set("Cookie", authCookie)
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.Mongoose.invalidIdFormat);
        });

        it("should return 404 for a non-existing upload ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${new mongoose.Types.ObjectId().toString()}`)
                .set("Cookie", authCookie)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.UserUploads.uploadNotFound);
        });

        it("should return the owner's upload without disk details", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${uploadId}`)
                .set("Cookie", authCookie)
                .expect("Content-Type", /json/)
                .expect(200);

            expectUploadResponse(response.body.upload, userId, "test.png", ".png");
            expect(response.body.upload.id).toBe(uploadId);
        });
    });

    describe("DELETE /upload/:id", (): void => {
        it("should not delete another user's upload", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/upload/${uploadId}`)
                .set("Cookie", otherCookie)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
            expect(fs.existsSync(uploadDiskPath)).toBe(true);
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/upload/abc")
                .set("Cookie", authCookie)
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.Mongoose.invalidIdFormat);
        });

        it("should return 404 for a non-existing upload ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/upload/${new mongoose.Types.ObjectId().toString()}`)
                .set("Cookie", authCookie)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.UserUploads.uploadNotFound);
        });

        it("should delete the owner's upload and its file", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/upload/${uploadId}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(response.body).toEqual({
                message: Responses.UserUploads.uploadDeletedSuccess,
                upload: { id: uploadId }
            });
            expect(fs.existsSync(uploadDiskPath)).toBe(false);

            await request(TestData.apiURL)
                .get(`/upload/${uploadId}`)
                .set("Cookie", authCookie)
                .expect(404);

            uploadId = undefined;
        });
    });

    describe("PATCH /upload/:id", (): void => {
        let patchUpload: any;

        const patchRequest = (body: object, cookie: string = authCookie): supertest.Test =>
            request(TestData.apiURL)
                .patch(`/upload/${patchUpload.id}`)
                .set("Cookie", cookie)
                .send(body);

        beforeAll(async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .attach("file", testPng, "patch.png")
                .expect(201);

            patchUpload = response.body.upload;
        });

        afterAll(async (): Promise<void> => {
            if (patchUpload) {
                await request(TestData.apiURL)
                    .delete(`/upload/${patchUpload.id}`)
                    .set("Cookie", authCookie);
            }
        });

        it("should rename the upload without changing its file or url", async (): Promise<void> => {
            const response: supertest.Response = await patchRequest({
                originalFileName: "  renamed.jpg  "
            })
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body.message).toBe(Responses.UserUploads.uploadUpdatedSuccess);

            const { upload } = response.body;
            expectUploadResponse(upload, userId, "renamed.jpg", ".png", "private");
            expect(upload.id).toBe(patchUpload.id);
            expect(upload.url).toBe(patchUpload.url);
            expect(upload.uploadedOn).toBe(patchUpload.uploadedOn);
            expect(new Date(upload.updatedOn).getTime()).toBeGreaterThan(
                new Date(patchUpload.updatedOn).getTime()
            );
            expect(fs.readFileSync(uploadDiskPathOf(userId, upload))).toEqual(testPng);
        });

        it("should change the visibility", async (): Promise<void> => {
            const response: supertest.Response = await patchRequest({
                visibility: "public"
            }).expect(200);

            expectUploadResponse(response.body.upload, userId, "renamed.jpg", ".png", "public");

            const detailsResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${patchUpload.id}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(detailsResponse.body.upload.visibility).toBe("public");
        });

        it("should rename and change the visibility at once", async (): Promise<void> => {
            const response: supertest.Response = await patchRequest({
                originalFileName: "both.png",
                visibility: "private"
            }).expect(200);

            expectUploadResponse(response.body.upload, userId, "both.png", ".png", "private");
        });

        it("should return 400 when there is nothing to update", async (): Promise<void> => {
            const response: supertest.Response = await patchRequest({})
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.UserUploads.nothingToUpdate });
        });

        it.each([
            ["an empty name", "   "],
            ["a name over 255 characters", "a".repeat(256)],
            ["a slash", "dir/name.png"],
            ["a backslash", "dir\\name.png"],
            ["a control character", "name\u0000.png"],
            ["a DEL character", "name\u007f.png"],
            ["a non-string name", 42]
        ])(
            "should return 400 for %s",
            async (_: string, originalFileName: unknown): Promise<void> => {
                const response: supertest.Response = await patchRequest({
                    originalFileName
                }).expect(400);

                expect(response.body).toEqual({ error: Responses.UserUploads.invalidFileName });
            }
        );

        it("should return 400 for an invalid visibility", async (): Promise<void> => {
            const response: supertest.Response = await patchRequest({
                visibility: "secret"
            }).expect(400);

            expect(response.body).toEqual({ error: Responses.UserUploads.invalidVisibility });
        });

        it("should not update another user's upload", async (): Promise<void> => {
            const response: supertest.Response = await patchRequest(
                { originalFileName: "stolen.png" },
                otherCookie
            ).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);

            const detailsResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${patchUpload.id}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(detailsResponse.body.upload.originalFileName).toBe("both.png");
        });

        it("should return 404 for a non-existing upload ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/upload/${new mongoose.Types.ObjectId().toString()}`)
                .set("Cookie", authCookie)
                .send({ visibility: "public" })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.UserUploads.uploadNotFound);
        });
    });

    describe("superuser on another user's upload", (): void => {
        const superuserCookie: string = TestData.superuser.cookie;
        let ownedUpload: any;

        const getUsageOf = async (cookie: string): Promise<any> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/uploads/usage")
                .set("Cookie", cookie)
                .expect(200);

            return response.body;
        };

        beforeAll(async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", otherCookie)
                .attach("file", testPng, "owned.png")
                .expect(201);

            ownedUpload = response.body.upload;
        });

        afterAll(async (): Promise<void> => {
            if (ownedUpload) {
                await request(TestData.apiURL)
                    .delete(`/upload/${ownedUpload.id}`)
                    .set("Cookie", otherCookie);
            }
        });

        it("should return another user's upload", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${ownedUpload.id}`)
                .set("Cookie", superuserCookie)
                .expect(200);

            expect(response.body.upload).toEqual(ownedUpload);
        });

        it("should rename and change the visibility of another user's upload", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/upload/${ownedUpload.id}`)
                .set("Cookie", superuserCookie)
                .send({ originalFileName: "moderated.png", visibility: "public" })
                .expect(200);

            expectUploadResponse(
                response.body.upload,
                otherUserId,
                "moderated.png",
                ".png",
                "public"
            );

            const detailsResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${ownedUpload.id}`)
                .set("Cookie", otherCookie)
                .expect(200);

            expect(detailsResponse.body.upload).toMatchObject({
                originalFileName: "moderated.png",
                visibility: "public",
                url: ownedUpload.url
            });
            expect(fs.readFileSync(uploadDiskPathOf(otherUserId, ownedUpload))).toEqual(testPng);
        });

        it("should delete another user's upload from the owner's usage", async (): Promise<void> => {
            const ownerUsageBefore: any = await getUsageOf(otherCookie);
            const superuserUsageBefore: any = await getUsageOf(superuserCookie);

            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/upload/${ownedUpload.id}`)
                .set("Cookie", superuserCookie)
                .expect(200);

            expect(response.body).toEqual({
                message: Responses.UserUploads.uploadDeletedSuccess,
                upload: { id: ownedUpload.id }
            });
            expect(fs.existsSync(uploadDiskPathOf(otherUserId, ownedUpload))).toBe(false);

            await request(TestData.apiURL)
                .get(`/upload/${ownedUpload.id}`)
                .set("Cookie", otherCookie)
                .expect(404);

            const ownerUsageAfter: any = await getUsageOf(otherCookie);
            expect(ownerUsageAfter.usedBytes).toBe(ownerUsageBefore.usedBytes - testPng.length);
            expect(ownerUsageAfter.count).toBe(ownerUsageBefore.count - 1);
            expect((await getUsageOf(superuserCookie)).usedBytes).toBe(
                superuserUsageBefore.usedBytes
            );

            ownedUpload = undefined;
        });
    });

    describe("POST /upload", (): void => {
        it("should store the file at <userId>/<id><ext>", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .attach("file", testPng, "Upper Case.PNG")
                .expect("Content-Type", /json/)
                .expect(201);

            expect(Object.keys(response.body).sort()).toEqual(["message", "upload"]);
            expect(response.body.message).toBe(Responses.UserUploads.uploadSuccess);

            const { upload } = response.body;
            expectUploadResponse(upload, userId, "Upper Case.PNG", ".png");
            expect(upload.url.endsWith(`/useruploads/${userId}/${upload.id}.png`)).toBe(true);

            const diskPath: string = uploadDiskPathOf(userId, upload);
            expect(fs.readFileSync(diskPath)).toEqual(testPng);

            await request(TestData.apiURL)
                .delete(`/upload/${upload.id}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(fs.existsSync(diskPath)).toBe(false);
        });

        it("should default to private without a visibility field", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .attach("file", testPng, "default.png")
                .expect(201);

            expectUploadResponse(response.body.upload, userId, "default.png", ".png", "private");

            await request(TestData.apiURL)
                .delete(`/upload/${response.body.upload.id}`)
                .set("Cookie", authCookie)
                .expect(200);
        });

        it("should store a public upload when visibility is public", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .field("visibility", "public")
                .attach("file", testPng, "public.png")
                .expect(201);

            const { upload } = response.body;
            expectUploadResponse(upload, userId, "public.png", ".png", "public");

            const detailsResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/upload/${upload.id}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(detailsResponse.body.upload.visibility).toBe("public");

            await request(TestData.apiURL)
                .delete(`/upload/${upload.id}`)
                .set("Cookie", authCookie)
                .expect(200);
        });

        it("should return 400 and remove the file for an invalid visibility", async (): Promise<void> => {
            const filesBefore: string[] = listUserUploadDir(userId);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .field("visibility", "secret")
                .attach("file", testPng, "secret.png")
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.UserUploads.invalidVisibility });
            expect(listUserUploadDir(userId)).toEqual(filesBefore);
        });

        it("should return 413 when the file is larger than the limit", async (): Promise<void> => {
            const maxMb: number = maxFileSizeBytes / 1024 / 1024;
            const filesBefore: string[] = listUserUploadDir(userId);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .attach("file", Buffer.alloc(maxFileSizeBytes + 1), "too-large.png")
                .expect("Content-Type", /json/)
                .expect(413);

            expect(response.body).toHaveProperty(
                "error",
                Responses.UserUploads.fileTooLarge(maxMb)
            );
            expect(listUserUploadDir(userId)).toEqual(filesBefore);
        }, 25000);

        it("should return 400 when no file is provided", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .field("description", "no file attached")
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.UserUploads.noFileProvided);
        });
    });

    describe("POST /upload file types", (): void => {
        const expectStored = async (
            content: Buffer,
            fileName: string,
            mimeType: string,
            extension: string
        ): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .attach("file", content, fileName)
                .expect(201);

            const { upload } = response.body;
            expect(upload.mimeType).toBe(mimeType);
            expect(upload.extension).toBe(extension);
            expect(upload.url.endsWith(`/useruploads/${userId}/${upload.id}${extension}`)).toBe(
                true
            );
            expect(fs.readFileSync(uploadDiskPathOf(userId, upload))).toEqual(content);

            await request(TestData.apiURL)
                .delete(`/upload/${upload.id}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(listUserUploadDir(userId).some((file) => file.startsWith(upload.id))).toBe(
                false
            );
        };

        const expectUnsupported = async (
            content: Buffer,
            fileName: string,
            contentType: string
        ): Promise<void> => {
            const filesBefore: string[] = listUserUploadDir(userId);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", authCookie)
                .attach("file", content, { filename: fileName, contentType })
                .expect("Content-Type", /json/)
                .expect(415);

            expect(response.body).toEqual({ error: Responses.UserUploads.unsupportedFileType });
            expect(listUserUploadDir(userId)).toEqual(filesBefore);
        };

        it("should store a PNG named .txt as .png", async (): Promise<void> => {
            await expectStored(testPng, "image.txt", "image/png", ".png");
        });

        it("should store a .jpeg upload as .jpg", async (): Promise<void> => {
            await expectStored(testJpeg, "photo.jpeg", "image/jpeg", ".jpg");
        });

        it("should store a PNG without an extension as .png", async (): Promise<void> => {
            await expectStored(testPng, "image", "image/png", ".png");
        });

        it("should accept a UTF-8 .md file as text/markdown", async (): Promise<void> => {
            const markdown: Buffer = Buffer.from("# Title\n\nÁrvíztűrő tükörfúrógép\n");
            await expectStored(markdown, "notes.md", "text/markdown", ".md");
        });

        it("should accept a valid .json file", async (): Promise<void> => {
            const json: Buffer = Buffer.from('{"key": "value"}');
            await expectStored(json, "data.json", "application/json", ".json");
        });

        it("should reject an HTML file named .png", async (): Promise<void> => {
            const html: Buffer = Buffer.from(
                "<!DOCTYPE html><html><script>alert(1)</script></html>"
            );
            await expectUnsupported(html, "image.png", "image/png");
        });

        it("should reject an SVG", async (): Promise<void> => {
            const svg: Buffer = Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
            );
            await expectUnsupported(svg, "image.svg", "image/svg+xml");
        });

        it("should reject a .json file with invalid JSON", async (): Promise<void> => {
            await expectUnsupported(Buffer.from("{invalid"), "data.json", "application/json");
        });

        it("should reject a .txt file that isn't valid UTF-8", async (): Promise<void> => {
            const invalidUtf8: Buffer = Buffer.from([0x68, 0x69, 0xff, 0xfe]);
            await expectUnsupported(invalidUtf8, "notes.txt", "text/plain");
        });

        it("should reject a .txt file with NUL bytes", async (): Promise<void> => {
            await expectUnsupported(Buffer.from("hi\u0000there"), "notes.txt", "text/plain");
        });

        it("should reject a text file without an extension", async (): Promise<void> => {
            await expectUnsupported(Buffer.from("plain text"), "notes", "text/plain");
        });
    });

    describe("GET /uploads", (): void => {
        const prefix: string = `list-${crypto.randomBytes(4).toString("hex")}-`;
        const uploads: any[] = [];
        let otherUpload: any;

        const createUpload = async (
            cookie: string,
            fileName: string,
            extraBytes: number,
            visibility: string = "private"
        ): Promise<any> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", cookie)
                .field("visibility", visibility)
                .attach("file", Buffer.concat([testPng, Buffer.alloc(extraBytes)]), fileName)
                .expect(201);

            return response.body.upload;
        };

        const listUploads = (query: string, cookie: string = authCookie): supertest.Test =>
            request(TestData.apiURL).get(`/uploads?${query}`).set("Cookie", cookie);

        const namesOf = (list: any[]): string[] =>
            list.map((upload: any): string => upload.originalFileName);

        beforeAll(async (): Promise<void> => {
            uploads.push(await createUpload(authCookie, `${prefix}B.png`, 20, "public"));
            uploads.push(await createUpload(authCookie, `${prefix}a.png`, 0));
            uploads.push(await createUpload(authCookie, `${prefix}c.png`, 10));
            uploads.push(await createUpload(authCookie, `${prefix}a.b*.png`, 30));
            uploads.push(await createUpload(authCookie, `${prefix}aXbbb.png`, 5));

            otherUpload = await createUpload(otherCookie, `${prefix}other.png`, 0);
        }, 25000);

        afterAll(async (): Promise<void> => {
            for (const upload of uploads) {
                await request(TestData.apiURL)
                    .delete(`/upload/${upload.id}`)
                    .set("Cookie", authCookie);
            }

            if (otherUpload) {
                await request(TestData.apiURL)
                    .delete(`/upload/${otherUpload.id}`)
                    .set("Cookie", otherCookie);
            }
        });

        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/uploads")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should list only the caller's uploads, newest first", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(`q=${prefix}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toEqual({
                uploads: [...uploads].reverse(),
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 5,
                    pages: 1,
                    sortBy: "uploadedOn",
                    sortOrder: "desc"
                }
            });

            const otherResponse: supertest.Response = await listUploads(
                `q=${prefix}`,
                otherCookie
            ).expect(200);

            expect(otherResponse.body.uploads).toEqual([otherUpload]);
            expect(otherResponse.body.pagination.total).toBe(1);
        });

        it("should filter by visibility", async (): Promise<void> => {
            const publicResponse: supertest.Response = await listUploads(
                `q=${prefix}&visibility=public`
            ).expect(200);

            expect(publicResponse.body.uploads).toEqual([uploads[0]]);
            expect(publicResponse.body.pagination.total).toBe(1);

            const privateResponse: supertest.Response = await listUploads(
                `q=${prefix}&visibility=private`
            ).expect(200);

            expect(privateResponse.body.uploads).toEqual(uploads.slice(1).reverse());
            expect(privateResponse.body.pagination.total).toBe(4);
        });

        it("should match q case-insensitively", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(
                `q=${encodeURIComponent(`${prefix}A.PNG`)}`
            ).expect(200);

            expect(response.body.uploads).toEqual([uploads[1]]);
        });

        it("should match regex characters in q literally", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(
                `q=${encodeURIComponent(`${prefix}a.b*`)}`
            ).expect(200);

            expect(response.body.uploads).toEqual([uploads[3]]);
            expect(response.body.pagination.total).toBe(1);
        });

        it("should sort by uploadedOn ascending", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(
                `q=${prefix}&sortOrder=asc`
            ).expect(200);

            expect(response.body.uploads).toEqual(uploads);
        });

        it("should sort by originalFileName case-insensitively", async (): Promise<void> => {
            const expectedNames: string[] = [
                "a.b*.png",
                "a.png",
                "aXbbb.png",
                "B.png",
                "c.png"
            ].map((name: string): string => `${prefix}${name}`);

            const ascResponse: supertest.Response = await listUploads(
                `q=${prefix}&sortBy=originalFileName&sortOrder=asc`
            ).expect(200);

            expect(namesOf(ascResponse.body.uploads)).toEqual(expectedNames);
            expect(ascResponse.body.pagination).toMatchObject({
                sortBy: "originalFileName",
                sortOrder: "asc"
            });

            const descResponse: supertest.Response = await listUploads(
                `q=${prefix}&sortBy=originalFileName&sortOrder=desc`
            ).expect(200);

            expect(namesOf(descResponse.body.uploads)).toEqual([...expectedNames].reverse());
        });

        it("should sort by fileSize", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(
                `q=${prefix}&sortBy=fileSize&sortOrder=asc`
            ).expect(200);

            const sizes: number[] = response.body.uploads.map(
                (upload: any): number => upload.fileSize
            );
            expect(sizes).toEqual(
                [0, 5, 10, 20, 30].map((extra: number): number => testPng.length + extra)
            );
        });

        it("should page the filtered result", async (): Promise<void> => {
            const pageTwo: supertest.Response = await listUploads(
                `q=${prefix}&sortOrder=asc&limit=2&page=2`
            ).expect(200);

            expect(pageTwo.body).toEqual({
                uploads: uploads.slice(2, 4),
                pagination: {
                    limit: 2,
                    page: 2,
                    total: 5,
                    pages: 3,
                    sortBy: "uploadedOn",
                    sortOrder: "asc"
                }
            });

            const pageThree: supertest.Response = await listUploads(
                `q=${prefix}&sortOrder=asc&limit=2&page=3`
            ).expect(200);

            expect(pageThree.body.uploads).toEqual(uploads.slice(4));

            const pageFour: supertest.Response = await listUploads(
                `q=${prefix}&sortOrder=asc&limit=2&page=4`
            ).expect(200);

            expect(pageFour.body.uploads).toEqual([]);
        });

        it("should return an empty page for the largest page number", async (): Promise<void> => {
            const response: supertest.Response = await listUploads(
                `q=${prefix}&limit=50&page=${Number.MAX_SAFE_INTEGER}`
            ).expect(200);

            expect(response.body).toEqual({
                uploads: [],
                pagination: {
                    limit: 50,
                    page: Number.MAX_SAFE_INTEGER,
                    total: 5,
                    pages: 1,
                    sortBy: "uploadedOn",
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
            ["sortBy", "sortBy=addedOn"],
            ["sortOrder", "sortOrder=up"],
            ["visibility", "visibility=secret"],
            ["q", `q=${"a".repeat(101)}`]
        ])("should return 400 for an invalid %s (%s)", async (param: string, query: string) => {
            const response: supertest.Response = await listUploads(query)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.UserUploads.invalidQuery(param) });
        });
    });
});

describe("Upload usage and quota API Tests", (): void => {
    let cookie: string;
    let userId: string;
    const uploadIds: string[] = [];

    const markdown: Buffer = Buffer.from("# Usage\n");

    const getUsage = async (): Promise<any> => {
        const response: supertest.Response = await request(TestData.apiURL)
            .get("/uploads/usage")
            .set("Cookie", cookie)
            .expect("Content-Type", /json/)
            .expect(200);

        return response.body;
    };

    const uploadAs = async (content: Buffer, fileName: string): Promise<any> => {
        const response: supertest.Response = await request(TestData.apiURL)
            .post("/upload")
            .set("Cookie", cookie)
            .attach("file", content, fileName)
            .expect(201);

        uploadIds.push(response.body.upload.id);

        return response.body.upload;
    };

    const deleteUploadAs = async (id: string): Promise<void> => {
        await request(TestData.apiURL).delete(`/upload/${id}`).set("Cookie", cookie).expect(200);
        uploadIds.splice(uploadIds.indexOf(id), 1);
    };

    const categoryOf = (usage: any, category: string): any =>
        usage.byCategory.find((entry: any) => entry.category === category);

    beforeAll(async (): Promise<void> => {
        await mongoose.connect(process.env.DB_CONNECTION_STRING);

        const user: TestUser = await createTestUser("q");
        cookie = user.cookie;
        userId = user.id;
    }, 25000);

    afterAll(async (): Promise<void> => {
        for (const id of [...uploadIds]) {
            await request(TestData.apiURL).delete(`/upload/${id}`).set("Cookie", cookie);
        }

        await mongoose.disconnect();
    });

    describe("GET /uploads/usage", (): void => {
        it("should reject the request when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/uploads/usage")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should return an empty usage for a new user", async (): Promise<void> => {
            const usage: any = await getUsage();

            expect(usage).toEqual({
                usedBytes: 0,
                quotaBytes: defaultUploadQuotaBytes,
                count: 0,
                maxFileSizeBytes,
                allowedTypes: ALLOWED_UPLOAD_TYPES,
                byCategory: UPLOAD_CATEGORIES.map((category) => ({ category, bytes: 0, count: 0 }))
            });
        });

        it("should match the usage after two uploads and a delete", async (): Promise<void> => {
            const before: any = await getUsage();

            const image: any = await uploadAs(testPng, "usage.png");
            await uploadAs(markdown, "usage.md");

            const afterUploads: any = await getUsage();

            expect(afterUploads.usedBytes).toBe(
                before.usedBytes + testPng.length + markdown.length
            );
            expect(afterUploads.count).toBe(before.count + 2);
            expect(afterUploads.byCategory).toHaveLength(5);
            expect(afterUploads.byCategory.map((entry: any) => entry.category)).toEqual([
                ...UPLOAD_CATEGORIES
            ]);
            expect(categoryOf(afterUploads, "image")).toEqual({
                category: "image",
                bytes: categoryOf(before, "image").bytes + testPng.length,
                count: categoryOf(before, "image").count + 1
            });
            expect(categoryOf(afterUploads, "document")).toEqual({
                category: "document",
                bytes: categoryOf(before, "document").bytes + markdown.length,
                count: categoryOf(before, "document").count + 1
            });

            await deleteUploadAs(image.id);

            const afterDelete: any = await getUsage();

            expect(afterDelete.usedBytes).toBe(before.usedBytes + markdown.length);
            expect(afterDelete.count).toBe(before.count + 1);
            expect(categoryOf(afterDelete, "image")).toEqual(categoryOf(before, "image"));
        });

        it("should count legacy mime types as documents", async (): Promise<void> => {
            const before: any = await getUsage();
            const legacyId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();

            await UserUploadsModel.create({
                _id: legacyId,
                originalFileName: "legacy.svg",
                storedFileName: `${legacyId}.svg`,
                filePath: path.join(process.env.UPLOAD_DISK_DIRECTORY, userId, `${legacyId}.svg`),
                extension: ".svg",
                fileSize: 7,
                mimeType: "image/svg+xml",
                uploadedBy: userId
            });
            uploadIds.push(legacyId.toString());

            const usage: any = await getUsage();

            expect(categoryOf(usage, "document").bytes).toBe(
                categoryOf(before, "document").bytes + 7
            );
            expect(categoryOf(usage, "image")).toEqual(categoryOf(before, "image"));

            await deleteUploadAs(legacyId.toString());
        });
    });

    describe("POST /upload quota", (): void => {
        it("should return 413 and remove the file when over the quota", async (): Promise<void> => {
            const { usedBytes }: any = await getUsage();
            const quotaBytes: number = usedBytes + testPng.length - 1;

            await UserModel.updateOne({ _id: userId }, { uploadQuotaBytes: quotaBytes });

            expect((await getUsage()).quotaBytes).toBe(quotaBytes);

            const filesBefore: string[] = listUserUploadDir(userId);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", cookie)
                .attach("file", testPng, "over-quota.png")
                .expect("Content-Type", /json/)
                .expect(413);

            expect(response.body).toEqual({ error: Responses.UserUploads.quotaExceeded });
            expect(listUserUploadDir(userId)).toEqual(filesBefore);
            expect((await getUsage()).usedBytes).toBe(usedBytes);
        });

        it("should accept an upload that fits the quota exactly", async (): Promise<void> => {
            const { usedBytes }: any = await getUsage();

            await UserModel.updateOne(
                { _id: userId },
                { uploadQuotaBytes: usedBytes + testPng.length }
            );

            await uploadAs(testPng, "exact-quota.png");
        });

        it("should not expose the quota field on GET /user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            expect(response.body).not.toHaveProperty("uploadQuotaBytes");
        });
    });
});

describe("Parallel uploads against the quota", (): void => {
    const twelveBytes: Buffer = Buffer.from("twelve bytes");
    const parallelUploads: number = 6;
    const racers: Map<number, TestUser> = new Map();

    const getUsage = async (cookie: string): Promise<any> => {
        const response: supertest.Response = await request(TestData.apiURL)
            .get("/uploads/usage")
            .set("Cookie", cookie)
            .expect(200);

        return response.body;
    };

    beforeAll(async (): Promise<void> => {
        for (const room of [1, 2]) {
            const racer: TestUser = await createTestUser("race");
            const { usedBytes }: any = await getUsage(racer.cookie);

            await request(TestData.apiURL)
                .patch(`/admin/users/${racer.id}/upload-quota`)
                .set("Cookie", TestData.superuser.cookie)
                .send({ quotaBytes: usedBytes + room * twelveBytes.length })
                .expect(200);

            racers.set(room, racer);
        }
    }, 25000);

    it.each([1, 2])(
        "should accept exactly the %i uploads that fit",
        async (room: number): Promise<void> => {
            const racer: TestUser = racers.get(room);

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: parallelUploads }, (_, index: number) =>
                    request(TestData.apiURL)
                        .post("/upload")
                        .set("Cookie", racer.cookie)
                        .attach("file", twelveBytes, `race-${index}.txt`)
                )
            );
            const statuses: number[] = responses
                .map((response) => response.status)
                .sort((a, b) => a - b);

            expect(statuses).toEqual([
                ...Array(room).fill(201),
                ...Array(parallelUploads - room).fill(413)
            ]);

            const usage: any = await getUsage(racer.cookie);

            expect(usage.usedBytes).toBe(usage.quotaBytes);
            expect(listUserUploadDir(racer.id)).toHaveLength(usage.count);
        }
    );
});

describe("GET /uploads/access", (): void => {
    let authCookie: string;
    let otherCookie: string;
    let otherUserId: string;
    let publicUpload: any;
    let privateUpload: any;
    let otherPrivateUpload: any;

    const uploadAs = async (cookie: string, fileName: string, visibility: string): Promise<any> => {
        const response: supertest.Response = await request(TestData.apiURL)
            .post("/upload")
            .set("Cookie", cookie)
            .field("visibility", visibility)
            .attach("file", testPng, fileName);

        expect(response.status).toBe(201);

        return response.body.upload;
    };

    const accessPathOf = (upload: any): string => new URL(upload.url).pathname;

    const checkAccess = (originalUri: string, cookie?: string): supertest.Test => {
        const accessRequest: supertest.Test = request(TestData.apiURL)
            .get("/uploads/access")
            .set("X-Original-URI", originalUri);

        return cookie ? accessRequest.set("Cookie", cookie) : accessRequest;
    };

    beforeAll(async (): Promise<void> => {
        authCookie = (await createTestUser()).cookie;

        const other: TestUser = await createTestUser();
        otherCookie = other.cookie;
        otherUserId = other.id;

        publicUpload = await uploadAs(authCookie, "my café (1).png", "public");
        privateUpload = await uploadAs(authCookie, "private.png", "private");
        otherPrivateUpload = await uploadAs(otherCookie, "other-private.png", "private");
    }, 25000);

    afterAll(async (): Promise<void> => {
        for (const upload of [publicUpload, privateUpload]) {
            if (upload) {
                await request(TestData.apiURL)
                    .delete(`/upload/${upload.id}`)
                    .set("Cookie", authCookie);
            }
        }

        if (otherPrivateUpload) {
            await request(TestData.apiURL)
                .delete(`/upload/${otherPrivateUpload.id}`)
                .set("Cookie", otherCookie);
        }
    });

    it("should allow a public upload anonymously with its headers", async (): Promise<void> => {
        const response: supertest.Response = await checkAccess(accessPathOf(publicUpload)).expect(
            204
        );

        expect(publicUpload.originalFileName).toBe("my café (1).png");
        expect(response.headers["x-upload-visibility"]).toBe("public");
        expect(response.headers["x-upload-filename"]).toBe("UTF-8''my%20caf%C3%A9%20%281%29.png");
    });

    it("should ignore the query string", async (): Promise<void> => {
        await checkAccess(`${accessPathOf(publicUpload)}?download=1&v=2`).expect(204);
    });

    it("should allow a private upload for its owner", async (): Promise<void> => {
        const response: supertest.Response = await checkAccess(
            accessPathOf(privateUpload),
            authCookie
        ).expect(204);

        expect(response.headers["x-upload-visibility"]).toBe("private");
        expect(response.headers["x-upload-filename"]).toBe("UTF-8''private.png");
    });

    it("should deny a private upload to another user", async (): Promise<void> => {
        await checkAccess(accessPathOf(privateUpload), otherCookie).expect(403);
    });

    it("should allow another user's private upload for the superuser", async (): Promise<void> => {
        const response: supertest.Response = await checkAccess(
            accessPathOf(otherPrivateUpload),
            TestData.superuser.cookie
        ).expect(204);

        expect(response.headers["x-upload-visibility"]).toBe("private");
    });

    it("should deny a private upload anonymously", async (): Promise<void> => {
        const response: supertest.Response = await checkAccess(accessPathOf(privateUpload)).expect(
            403
        );

        expect(response.headers).not.toHaveProperty("x-upload-visibility");
    });

    it("should deny an upload under another user's folder", async (): Promise<void> => {
        await checkAccess(
            `/useruploads/${otherUserId}/${publicUpload.id}${publicUpload.extension}`
        ).expect(403);
    });

    it("should deny an upload with the wrong extension", async (): Promise<void> => {
        await checkAccess(accessPathOf(publicUpload).replace(/\.png$/, ".jpg")).expect(403);
    });

    it("should deny an unknown upload ID", async (): Promise<void> => {
        const unknownId: string = new mongoose.Types.ObjectId().toString();

        await checkAccess(accessPathOf(publicUpload).replace(publicUpload.id, unknownId)).expect(
            403
        );
    });

    it("should deny a request without X-Original-URI", async (): Promise<void> => {
        await request(TestData.apiURL).get("/uploads/access").expect(403);
    });

    it.each([
        ["a path outside /useruploads", (uri: string) => uri.replace("/useruploads/", "/uploads/")],
        ["an upper case extension", (uri: string) => uri.replace(/\.png$/, ".PNG")],
        ["a short upload ID", (uri: string) => uri.replace(/[0-9a-f]{24}(\.png)$/, "abc$1")],
        ["a trailing path segment", (uri: string) => `${uri}/../x.png`],
        ["a percent-encoded path", (uri: string) => uri.replace(/\.png$/, "%2epng")]
    ])("should deny %s", async (_: string, toMalformed: (uri: string) => string): Promise<void> => {
        await checkAccess(toMalformed(accessPathOf(publicUpload))).expect(403);
    });
});

describe("DELETE /users/:id uploads", (): void => {
    let user: TestUser;
    let upload: any;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("del");

        const uploadResponse: supertest.Response = await request(TestData.apiURL)
            .post("/upload")
            .set("Cookie", user.cookie)
            .field("visibility", "public")
            .attach("file", testPng, "deleted-user.png")
            .expect(201);

        upload = uploadResponse.body.upload;
    }, 25000);

    it("should remove the user's upload folder and records", async (): Promise<void> => {
        expect(fs.existsSync(uploadDiskPathOf(user.id, upload))).toBe(true);

        await request(TestData.apiURL)
            .delete(`/users/${user.id}`)
            .set("Cookie", user.cookie)
            .expect("Content-Type", /json/)
            .expect(200);

        expect(fs.existsSync(path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id))).toBe(false);

        await request(TestData.apiURL)
            .get("/uploads/access")
            .set("X-Original-URI", new URL(upload.url).pathname)
            .expect(403);
    });
});

describe("DELETE /users/:id during an upload", (): void => {
    let deletedBeforeFile: TestUser;
    let deletedDuringFile: TestUser;
    let deletedBeforeUnsupported: TestUser;
    let deletedBeforeInvalidVisibility: TestUser;
    let deletedBeforeTooLarge: TestUser;

    interface StreamedUpload {
        boundary: string;
        uploadRequest: http.ClientRequest;
        uploadResponse: Promise<{ status: number; text: string }>;
    }

    const readResponse = (
        response: http.IncomingMessage
    ): Promise<{ status: number; text: string }> =>
        new Promise((resolve, reject): void => {
            let text: string = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string): void => {
                text += chunk;
            });
            response.on("end", (): void => resolve({ status: response.statusCode, text }));
            response.on("error", reject);
        });

    const startUpload = (cookie: string, visibility: string = "public"): StreamedUpload => {
        const boundary: string = `vb2007-${randomHex(8)}`;
        const uploadRequest: http.ClientRequest = http.request(`${TestData.apiURL}/upload`, {
            method: "POST",
            headers: {
                Cookie: cookie,
                "Content-Type": `multipart/form-data; boundary=${boundary}`
            }
        });
        let hasReplied: boolean = false;
        const uploadResponse: Promise<{ status: number; text: string }> = new Promise(
            (resolve, reject): void => {
                uploadRequest.on("response", (response: http.IncomingMessage): void => {
                    hasReplied = true;
                    readResponse(response).then(resolve, reject);
                });
                uploadRequest.on("error", (error: Error): void => {
                    if (!hasReplied) {
                        reject(error);
                    }
                });
            }
        );

        uploadRequest.write(
            `--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\n${visibility}\r\n`
        );

        return { boundary, uploadRequest, uploadResponse };
    };

    const writeFilePartHeader = (
        { boundary, uploadRequest }: StreamedUpload,
        fileName: string = "streamed.png",
        contentType: string = "image/png"
    ): void => {
        uploadRequest.write(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
        );
    };

    const finishUpload = ({ boundary, uploadRequest }: StreamedUpload, rest: Buffer): void => {
        uploadRequest.write(rest);
        uploadRequest.end(`\r\n--${boundary}--\r\n`);
    };

    const deleteUserAs = async (user: TestUser): Promise<void> => {
        await request(TestData.apiURL)
            .delete(`/users/${user.id}`)
            .set("Cookie", user.cookie)
            .expect(200);
    };

    const startUploadThenDeleteUser = async (
        user: TestUser,
        visibility?: string
    ): Promise<StreamedUpload> => {
        const upload: StreamedUpload = startUpload(user.cookie, visibility);

        await new Promise((resolve) => setTimeout(resolve, 1000));
        await deleteUserAs(user);

        return upload;
    };

    const waitUntil = async (condition: () => boolean): Promise<void> => {
        while (!condition()) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };

    const expectRefusedWithoutLeftovers = async (
        user: TestUser,
        { uploadResponse }: StreamedUpload,
        expectedStatus: number = 403,
        expectedError: string = Responses.notLoggedIn
    ): Promise<void> => {
        const { status, text } = await uploadResponse;

        expect(status).toBe(expectedStatus);
        expect(JSON.parse(text)).toEqual({ error: expectedError });
        expect(await UserUploadsModel.countDocuments({ uploadedBy: user.id })).toBe(0);
        expect(fs.existsSync(path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id))).toBe(false);
    };

    beforeAll(async (): Promise<void> => {
        await mongoose.connect(process.env.DB_CONNECTION_STRING);

        deletedBeforeFile = await createTestUser("delup");
        deletedDuringFile = await createTestUser("delup");
        deletedBeforeUnsupported = await createTestUser("delup");
        deletedBeforeInvalidVisibility = await createTestUser("delup");
        deletedBeforeTooLarge = await createTestUser("delup");
    }, 25000);

    afterAll(async (): Promise<void> => {
        await mongoose.disconnect();
    });

    it("should refuse an upload whose user was deleted before its file part", async (): Promise<void> => {
        const upload: StreamedUpload = await startUploadThenDeleteUser(deletedBeforeFile);

        writeFilePartHeader(upload);
        finishUpload(upload, testPng);

        await expectRefusedWithoutLeftovers(deletedBeforeFile, upload);
    }, 25000);

    it("should refuse an upload whose user was deleted while its file streamed", async (): Promise<void> => {
        const upload: StreamedUpload = startUpload(deletedDuringFile.cookie);

        writeFilePartHeader(upload);
        upload.uploadRequest.write(testPng.subarray(0, 8));

        await waitUntil((): boolean => listUserUploadDir(deletedDuringFile.id).length > 0);
        await deleteUserAs(deletedDuringFile);

        finishUpload(upload, testPng.subarray(8));

        await expectRefusedWithoutLeftovers(deletedDuringFile, upload);
    }, 25000);

    it("should remove the folder of a deleted user's upload with an unsupported type", async (): Promise<void> => {
        const upload: StreamedUpload = await startUploadThenDeleteUser(deletedBeforeUnsupported);

        writeFilePartHeader(upload, "program.exe", "application/octet-stream");
        finishUpload(upload, Buffer.from("MZ not an allowed type"));

        await expectRefusedWithoutLeftovers(
            deletedBeforeUnsupported,
            upload,
            415,
            Responses.UserUploads.unsupportedFileType
        );
    }, 25000);

    it("should remove the folder of a deleted user's upload with an invalid visibility", async (): Promise<void> => {
        const upload: StreamedUpload = await startUploadThenDeleteUser(
            deletedBeforeInvalidVisibility,
            "secret"
        );

        writeFilePartHeader(upload);
        finishUpload(upload, testPng);

        await expectRefusedWithoutLeftovers(
            deletedBeforeInvalidVisibility,
            upload,
            400,
            Responses.UserUploads.invalidVisibility
        );
    }, 25000);

    it("should remove the folder of a deleted user's upload that is too large", async (): Promise<void> => {
        const upload: StreamedUpload = await startUploadThenDeleteUser(deletedBeforeTooLarge);

        writeFilePartHeader(upload);
        finishUpload(upload, Buffer.alloc(maxFileSizeBytes + 1));

        await expectRefusedWithoutLeftovers(
            deletedBeforeTooLarge,
            upload,
            413,
            Responses.UserUploads.fileTooLarge(maxFileSizeBytes / 1024 / 1024)
        );
    }, 25000);
});
