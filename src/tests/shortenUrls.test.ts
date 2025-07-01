import request from "supertest";
import { TestData } from "./testData";
import { generateRandomString } from "helpers/text";

describe("URL Shortening API Tests", () => {
    describe("GET /r/:shortenedUrl", () => {
        it("should redirect the user to the original URL", async () => {
            const response = await request(TestData.apiURL)
                .get(`/r/${TestData.ShortUrlData.testShortenedUrl}`)
                .expect(200);
        });

        it("should return 404 for a non-existent URL", async () => {
            const response = await request(TestData.apiURL).get(`/r/`).expect(404);
        });
    });

    describe("POST /shortenUrl/create", () => {
        const validUrl: string = "http://" + generateRandomString(5) + ".com";

        it("should successfully create a new shortened URL", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .send({ url: validUrl })
                .expect(201);
        });

        it("should return the already existing short URL if user tries to shorten an URL that already exists", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .send({ url: TestData.ShortUrlData.existingUrl })
                .expect(200);
        });

        it("shouldn't shorten URIs with unsupported protocols", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .send({ url: "unsupported://protocol.com" })
                .expect(400);
        });

        it("shouldn't shorten an URL with spaces", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .send({ url: TestData.ShortUrlData.urlWithSpaces })
                .expect(400);
        });
    });
});
