import request from "supertest";
import { TestData } from "../constants/testData";
import { generateRandomString } from "../helpers/text";
import { Responses } from "../constants/responses";

describe("URL Shortening API Tests", () => {
    describe("GET /r/:shortenedUrl", () => {
        it("should redirect the user to the original URL", async () => {
            const response = await request(TestData.apiURL)
                .get(`/r/${TestData.ShortUrlData.testShortenedUrl}`)
                .expect(302);

            expect(response.headers.location).toBe(TestData.ShortUrlData.existing);
        });

        it("should return 404 for a non-existent URL", async () => {
            const response = await request(TestData.apiURL).get(`/r/nonExistent`).expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);
        });
    });

    describe("POST /shortenUrl/create", () => {
        const validUrl: string = "http://" + generateRandomString(5) + ".com";
        let authCookie: string;
        const urlsToCleanup: string[] = [];

        beforeAll(async () => {
            const loginResponse = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: TestData.email, password: TestData.password });

            authCookie = loginResponse.headers["set-cookie"][0];

            urlsToCleanup.push(
                validUrl,
                // TestData.ShortUrlData.existing,
                TestData.ShortUrlData.unsupportedProtocol,
                TestData.ShortUrlData.containsSpaces
            );
        });

        afterAll(async () => {
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

        it("should successfully create a new shortened URL", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: validUrl })
                .expect(201);

            expect(response.body).toHaveProperty(
                "message",
                Responses.ShortenUrl.urlShortenedSuccess
            );
        });

        it("should return the already existing short URL if user tries to shorten an URL that already exists", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: TestData.ShortUrlData.existing })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.alreadyShortened);
        });

        it("shouldn't shorten URIs with unsupported protocols", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: TestData.ShortUrlData.unsupportedProtocol })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });

        it("shouldn't shorten an URL with spaces", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", authCookie)
                .send({ url: TestData.ShortUrlData.containsSpaces })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });
    });
});
