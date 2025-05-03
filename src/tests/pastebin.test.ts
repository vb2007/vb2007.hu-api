import request from "supertest";
import express from "express";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import cors from "cors";
import router from "../router";

// Extend Express Request to include identity property
declare global {
    namespace Express {
        interface Request {
            identity?: {
                _id: string;
                username: string;
                [key: string]: any;
            };
        }
    }
}

describe("Pastebin API Tests", () => {
    let app: express.Application;
    let authCookie: string;
    let testUserId: string;
    let testUsername: string;

    beforeAll(async () => {
        // Create a test Express app
        app = express();
        app.use(
            cors({
                origin: "http://localhost:3000",
                credentials: true
            })
        );
        app.use(bodyParser.json());
        app.use(cookieParser());
        app.use("/", router());

        // Login with existing test user credentials
        // Note: Replace these with your test user credentials
        const loginResponse = await request(app).post("/auth/login").send({
            email: "testuser@example.com", // TODO: Replace with actual test user email
            password: "testpassword123" // TODO: Replace with actual test user password
        });

        // Check if login was successful
        expect(loginResponse.status).toBe(200);

        // Extract the auth cookie for subsequent requests
        authCookie = loginResponse.headers["set-cookie"][0];

        // Save test user info for later use
        testUserId = loginResponse.body._id;
        testUsername = loginResponse.body.username;
    });

    describe("GET /paste/:id", () => {
        let createdPasteId: string;

        // Create a test paste first that we can retrieve
        beforeAll(async () => {
            const createResponse = await request(app)
                .post("/paste")
                .set("Cookie", authCookie)
                .send({ paste: "This is a test paste content" });

            expect(createResponse.status).toBe(201);
            createdPasteId = createResponse.body._id;
        });

        it("should return a paste when given a valid ID", async () => {
            // Act
            const response = await request(app)
                .get(`/paste/${createdPasteId}`)
                .expect("Content-Type", /json/)
                .expect(200);

            // Assert
            expect(response.body).toHaveProperty("paste");
            expect(response.body.paste.content).toBe("This is a test paste content");
            expect(response.body.paste._id).toBe(createdPasteId);
        });

        it("should return 404 for non-existing paste ID", async () => {
            const nonExistingId = new mongoose.Types.ObjectId().toString();

            await request(app).get(`/paste/${nonExistingId}`).expect(404);
        });
    });

    describe("POST /paste", () => {
        it("should create a new paste when authenticated", async () => {
            // Arrange
            const pasteContent = "New paste content for testing";

            // Act
            const response = await request(app)
                .post("/paste")
                .set("Cookie", authCookie)
                .send({ paste: pasteContent })
                .expect("Content-Type", /json/)
                .expect(201);

            // Assert
            expect(response.body).toHaveProperty("_id");
            expect(response.body).toHaveProperty("content");
            expect(response.body.content).toBe(pasteContent);
            expect(response.body.addedBy).toBe(testUserId);
        });

        it("should reject paste creation when not authenticated", async () => {
            await request(app)
                .post("/paste")
                .send({ paste: "Unauthorized paste content" })
                .expect(403);
        });
    });

    describe("User pastes", () => {
        it("should get pastes by username when authenticated", async () => {
            const response = await request(app)
                .get(`/pastes/${testUsername}`)
                .set("Cookie", authCookie)
                .expect(200);

            expect(response.body).toHaveProperty("pastes");
            expect(response.body).toHaveProperty("pagination");
            expect(Array.isArray(response.body.pastes)).toBe(true);
        });
    });
});
