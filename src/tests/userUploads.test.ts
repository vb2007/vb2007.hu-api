import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { maxFileSizeBytes } from "../helpers/multer";

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const testJpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expect(response.status).toBe(200);

    return response.headers["set-cookie"][0];
};

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

    const otherUsername: string = `t${crypto.randomBytes(6).toString("hex")}`;
    const otherEmail: string = `${otherUsername}@test.com`;
    const otherPassword: string = crypto.randomBytes(12).toString("hex");

    beforeAll(async (): Promise<void> => {
        authCookie = await login(TestData.email, TestData.password);

        const ownUserResponse: supertest.Response = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", authCookie);

        userId = ownUserResponse.body._id;

        const registerResponse: supertest.Response = await request(TestData.apiURL)
            .post("/auth/register")
            .send({ username: otherUsername, email: otherEmail, password: otherPassword });

        expect(registerResponse.status).toBe(201);

        otherCookie = await login(otherEmail, otherPassword);

        const userResponse: supertest.Response = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", otherCookie);

        otherUserId = userResponse.body._id;

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

        if (otherUserId) {
            await request(TestData.apiURL)
                .delete(`/users/${otherUserId}`)
                .set("Cookie", otherCookie);
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
});
