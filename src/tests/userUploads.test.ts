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

const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expect(response.status).toBe(200);

    return response.headers["set-cookie"][0];
};

const expectUploadResponse = (upload: any, userId: string, fileName: string, ext: string): void => {
    expect(upload).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{24}$/),
        originalFileName: fileName,
        extension: ext,
        mimeType: "image/png",
        fileSize: testPng.length,
        visibility: "private",
        url: `${process.env.CDN_URL}/useruploads/${userId}/${upload.id}${ext}`,
        uploadedOn: expect.any(String),
        updatedOn: expect.any(String)
    });
    expect(new Date(upload.uploadedOn).toISOString()).toBe(upload.uploadedOn);
    expect(new Date(upload.updatedOn).toISOString()).toBe(upload.updatedOn);
};

const uploadDiskPathOf = (userId: string, upload: any): string =>
    path.join(process.env.UPLOAD_DISK_DIRECTORY, userId, `${upload.id}${upload.extension}`);

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
});
