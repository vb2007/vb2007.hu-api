import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";

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

describe("User Uploads API Tests", (): void => {
    let authCookie: string;
    let otherCookie: string;
    let otherUserId: string;
    let uploadId: string;
    let uploadDiskPath: string;

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

        const uploadResponse: supertest.Response = await request(TestData.apiURL)
            .post("/upload")
            .set("Cookie", authCookie)
            .attach("file", testPng, "test.png");

        expect(uploadResponse.status).toBe(201);

        uploadId = uploadResponse.body.upload.id;
        uploadDiskPath = path.join(
            process.env.UPLOAD_DISK_DIRECTORY,
            TestData.username,
            path.basename(uploadResponse.body.upload.directUrl)
        );
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

            expect(response.body.upload._id).toBe(uploadId);
            expect(response.body.upload.originalFileName).toBe("test.png");
            expect(response.body.upload).not.toHaveProperty("filePath");
            expect(response.body.upload).not.toHaveProperty("storedFileName");
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
});
