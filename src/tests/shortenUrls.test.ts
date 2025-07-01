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
        it("shouldn't let users shorten URIs with unsupported protocols", async () => {
            const response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .send({ url: "unsupported://protocol.com" })
                .expect(400);
        });

        it("should successfully create a ");
    });
});
