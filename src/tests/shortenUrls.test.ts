import request from "supertest";
import crypto from "crypto";
import { TestData } from "../constants/testData";
import { generateRandomString } from "../helpers/text";
import { Responses } from "../constants/responses";
import supertest from "supertest";

const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expect(response.status).toBe(200);

    return response.headers["set-cookie"][0];
};

describe("URL Shortening API Tests", (): void => {
    describe("GET /r/:shortenedUrl", (): void => {
        it("should redirect the user to the original URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/r/${TestData.ShortUrlData.testShortenedUrl}`)
                .expect(302);

            expect(response.headers.location).toBe(TestData.ShortUrlData.existing);
        });

        it("should return 404 for a non-existent URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/r/nonExistent`)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);
        });
    });

    describe("GET /shortenUrl/:shortenedUrl", (): void => {
        it("should return the original URL for a valid shortened URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/shortenUrl/${TestData.ShortUrlData.testShortenedUrl}`)
                .expect(200);

            expect(response.body).toHaveProperty("originalUrl", TestData.ShortUrlData.existing);
            expect(response.body).toHaveProperty("addedOn");
        });

        it("should return the user details in addedBy instead of just an ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/shortenUrl/${TestData.ShortUrlData.testShortenedUrl}`)
                .expect(200);

            expect(typeof response.body.addedBy).toBe("object");
            expect(response.body.addedBy).toEqual(
                expect.objectContaining({
                    _id: expect.any(String),
                    username: expect.any(String),
                    createdAt: expect.any(String)
                })
            );
            expect(response.body.addedBy).not.toHaveProperty("email");
        });

        it("shouldn't expose sensitive user data in addedBy", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/shortenUrl/${TestData.ShortUrlData.testShortenedUrl}`)
                .expect(200);

            expect(response.body.addedBy).not.toHaveProperty("authentication");
            expect(response.body.addedBy).not.toHaveProperty("password");
            expect(response.body.addedBy).not.toHaveProperty("sessionToken");
        });

        it("should return 404 for a non-existent shortened URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/shortenUrl/nonExistent`)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);
        });
    });

    describe("POST /shortenUrl/create", (): void => {
        const validUrl: string = "http://" + generateRandomString(5) + ".com";
        let authCookie: string;
        const urlsToCleanup: string[] = [];

        beforeAll(async (): Promise<void> => {
            const loginResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: TestData.email, password: TestData.password });

            expect(loginResponse.status).toBe(200);

            authCookie = loginResponse.headers["set-cookie"][0];
        });

        afterAll(async (): Promise<void> => {
            for (const url of urlsToCleanup) {
                try {
                    await request(TestData.apiURL)
                        .delete("/shortenUrl/delete")
                        .set("Cookie", authCookie)
                        .send({ shortenedUrl: url })
                        .catch(() => {});
                } catch (error) {}
            }
        });

        it("should successfully create a new shortened URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: validUrl })
                .expect(201);

            urlsToCleanup.push(response.body.data.shortenedUrl);

            expect(response.body).toHaveProperty(
                "message",
                Responses.ShortenUrl.urlShortenedSuccess
            );
        });

        it("should return the already existing short URL if user tries to shorten an URL that already exists", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: TestData.ShortUrlData.existing })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.alreadyShortened);
        });

        it("shouldn't shorten URIs with unsupported protocols", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: TestData.ShortUrlData.unsupportedProtocol })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });

        it("shouldn't shorten an URL with spaces", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: TestData.ShortUrlData.containsSpaces })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });
    });

    describe("DELETE /shortenUrl/delete", (): void => {
        let authCookie: string;
        let otherCookie: string;
        let otherUserId: string;
        let shortenedUrl: string;

        const originalUrl: string = `http://${generateRandomString(8)}.com`;
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

            const createResponse: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: originalUrl });

            expect(createResponse.status).toBe(201);

            shortenedUrl = createResponse.body.data.shortenedUrl;
        }, 25000);

        afterAll(async (): Promise<void> => {
            if (shortenedUrl) {
                await request(TestData.apiURL)
                    .delete("/shortenUrl/delete")
                    .set("Cookie", authCookie)
                    .send({ shortenedUrl });
            }

            if (otherUserId) {
                await request(TestData.apiURL)
                    .delete(`/users/${otherUserId}`)
                    .set("Cookie", otherCookie);
            }
        });

        it("should not delete another user's short link", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", otherCookie)
                .send({ shortenedUrl })
                .expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.ShortenUrl.notAuthorizedToDelete
            );

            const redirectResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/r/${shortenedUrl}`)
                .expect(302);

            expect(redirectResponse.headers.location).toBe(originalUrl);
        });

        it("should return 400 for a missing short code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", authCookie)
                .send({})
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.missingShortenedUrl);
        });

        it("should return 404 for an unknown short code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", authCookie)
                .send({ shortenedUrl: "nonExistent" })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);
        });

        it("should delete the short link for its owner", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", authCookie)
                .send({ shortenedUrl })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.urlDeletedSuccess);

            await request(TestData.apiURL).get(`/r/${shortenedUrl}`).expect(404);
        });
    });
});
