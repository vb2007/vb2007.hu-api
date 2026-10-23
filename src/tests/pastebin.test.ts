import request from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import supertest from "supertest";

const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expect(response.status).toBe(200);

    return response.headers["set-cookie"][0];
};

describe("Pastebin API Tests", (): void => {
    let authCookie: string;
    // let testUserId: string;
    let testUsername: string = TestData.username;

    beforeAll(async (): Promise<void> => {
        const loginResponse: supertest.Response = await request(TestData.apiURL)
            .post("/auth/login")
            .send({
                email: TestData.email,
                password: TestData.password
            });

        expect(loginResponse.status).toBe(200);

        authCookie = loginResponse.headers["set-cookie"][0];

        // DEPRACATED: /auth/login doesn't returns user data anymore
        // testUserId = loginResponse.body._id;
        // testUsername = loginResponse.body.username;
    }, 25000);

    describe("GET /paste/:id", (): void => {
        const testPasteId: mongoose.Types.ObjectId = TestData.PastebinData.testPasteId;

        it("should return a paste when given a valid ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${testPasteId}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toHaveProperty("paste");
            expect(response.body.paste.content).toBe(TestData.PastebinData.testPasteContent);
            expect(response.body.paste._id).toBe(testPasteId.toString());
        });

        it("should return 404 for non-existing paste ID", async (): Promise<void> => {
            const nonExistingId: string = new mongoose.Types.ObjectId().toString();

            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${nonExistingId}`)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.Pastebin.pasteNotFound);
        });
    });

    describe("POST /paste", (): void => {
        // TODO: needs cleanup
        // it("should create a new paste when authenticated", async () => {
        //     const pasteContent = "New paste content for testing";

        //     const response = await request(TestData.apiURL)
        //         .post("/paste")
        //         .set("Cookie", authCookie)
        //         .send({ paste: pasteContent })
        //         .expect("Content-Type", /json/)
        //         .expect(201);

        //     expect(response.body).toHaveProperty("_id");
        //     expect(response.body).toHaveProperty("content");
        //     expect(response.body.content).toBe(pasteContent);
        //     expect(response.body.addedBy).toBe(testUserId);
        // });

        it("should reject paste creation when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .send({ paste: "Unauthorized paste content" })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });
    });

    describe("GET /pastes/:username", (): void => {
        it("should get pastes by username when authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/pastes/${testUsername}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(response.body).toHaveProperty("pastes");
            expect(response.body).toHaveProperty("pagination");
            expect(Array.isArray(response.body.pastes)).toBe(true);
        });
    });

    describe("DELETE /paste/:id", (): void => {
        let otherCookie: string;
        let otherUserId: string;
        let pasteId: string;

        const otherUsername: string = `t${crypto.randomBytes(6).toString("hex")}`;
        const otherEmail: string = `${otherUsername}@test.com`;
        const otherPassword: string = crypto.randomBytes(12).toString("hex");
        const pasteContent: string = "Paste content for ownership testing";

        beforeAll(async (): Promise<void> => {
            const registerResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/register")
                .send({ username: otherUsername, email: otherEmail, password: otherPassword });

            expect(registerResponse.status).toBe(201);

            otherCookie = await login(otherEmail, otherPassword);

            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", otherCookie);

            otherUserId = userResponse.body._id;

            const pasteResponse: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .set("Cookie", authCookie)
                .send({ paste: pasteContent });

            expect(pasteResponse.status).toBe(201);

            pasteId = pasteResponse.body.paste._id;
        }, 25000);

        afterAll(async (): Promise<void> => {
            if (pasteId) {
                await request(TestData.apiURL)
                    .delete(`/paste/${pasteId}`)
                    .set("Cookie", authCookie);
            }

            if (otherUserId) {
                await request(TestData.apiURL)
                    .delete(`/users/${otherUserId}`)
                    .set("Cookie", otherCookie);
            }
        });

        it("should not delete another user's paste", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${pasteId}`)
                .set("Cookie", otherCookie)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);

            const getResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${pasteId}`)
                .expect(200);

            expect(getResponse.body.paste.content).toBe(pasteContent);
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            await request(TestData.apiURL)
                .delete("/paste/abc")
                .set("Cookie", authCookie)
                .expect(400);
        });

        it("should return 404 for non-existing paste ID", async (): Promise<void> => {
            const nonExistingId: string = new mongoose.Types.ObjectId().toString();

            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${nonExistingId}`)
                .set("Cookie", authCookie)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.Pastebin.pasteNotFound);
        });

        it("should delete the paste for its owner", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${pasteId}`)
                .set("Cookie", authCookie)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body.message).toBe(Responses.Pastebin.pasteDeletedSuccess);
            expect(response.body.paste).toEqual({ id: pasteId });

            await request(TestData.apiURL).get(`/paste/${pasteId}`).expect(404);
        });
    });
});
