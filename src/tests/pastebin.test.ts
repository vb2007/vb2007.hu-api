import request from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";

describe("Pastebin API Tests", () => {
    let authCookie: string;
    let testUserId: string;
    let testUsername: string = TestData.username;

    beforeAll(async () => {
        const loginResponse = await request(TestData.apiURL).post("/auth/login").send({
            email: TestData.email,
            password: TestData.password
        });

        expect(loginResponse.status).toBe(200);

        authCookie = loginResponse.headers["set-cookie"][0];

        // DEPRACATED: /auth/login doesn't returns user data anymore
        // testUserId = loginResponse.body._id;
        // testUsername = loginResponse.body.username;
    }, 15000);

    describe("GET /paste/:id", () => {
        const testPasteId: mongoose.Types.ObjectId = TestData.PastebinData.testPasteId;

        it("should return a paste when given a valid ID", async () => {
            const response = await request(TestData.apiURL)
                .get(`/paste/${testPasteId}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toHaveProperty("paste");
            expect(response.body.paste.content).toBe(TestData.PastebinData.testPasteContent);
            expect(response.body.paste._id).toBe(testPasteId.toString());
        });

        it("should return 404 for non-existing paste ID", async () => {
            const nonExistingId = new mongoose.Types.ObjectId().toString();

            await request(TestData.apiURL).get(`/paste/${nonExistingId}`).expect(404);
        });
    });

    describe("POST /paste", () => {
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

        it("should reject paste creation when not authenticated", async () => {
            await request(TestData.apiURL)
                .post("/paste")
                .send({ paste: "Unauthorized paste content" })
                .expect(403);
        });
    });

    describe("User pastes", () => {
        it("should get pastes by username when authenticated", async () => {
            const response = await request(TestData.apiURL)
                .get(`/pastes/${testUsername}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(response.body).toHaveProperty("pastes");
            expect(response.body).toHaveProperty("pagination");
            expect(Array.isArray(response.body.pastes)).toBe(true);
        });
    });
});
