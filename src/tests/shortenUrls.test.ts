import request from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { TestUser, createTestUser, randomHex } from "./helpers/testUsers";
import supertest from "supertest";

const uniqueUrl = (): string => `https://${TestData.runId}-${randomHex(8)}.vb2007.test/`;

const createShortUrl = async (cookie: string, url: string = uniqueUrl()): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/shortenUrl/create")
        .set("Cookie", cookie)
        .send({ url });

    expect(response.status).toBe(201);

    return response.body.data.shortenedUrl;
};

describe("URL Shortening API Tests", (): void => {
    const existingUrl: string = uniqueUrl();
    let owner: TestUser;
    let existingShortUrl: string;

    beforeAll(async (): Promise<void> => {
        owner = await createTestUser();
        existingShortUrl = await createShortUrl(owner.cookie, existingUrl);
    }, 25000);

    describe("GET /r/:shortenedUrl", (): void => {
        it("should redirect the user to the original URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/r/${existingShortUrl}`)
                .expect(302);

            expect(response.headers.location).toBe(existingUrl);
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
                .get(`/shortenUrl/${existingShortUrl}`)
                .expect(200);

            expect(response.body).toHaveProperty("originalUrl", existingUrl);
            expect(response.body).toHaveProperty("addedOn");
        });

        it("should return the user details in addedBy instead of just an ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/shortenUrl/${existingShortUrl}`)
                .expect(200);

            expect(typeof response.body.addedBy).toBe("object");
            expect(response.body.addedBy).toEqual(
                expect.objectContaining({
                    _id: owner.id,
                    username: owner.username,
                    createdAt: expect.any(String)
                })
            );
            expect(response.body.addedBy).not.toHaveProperty("email");
        });

        it("shouldn't expose sensitive user data in addedBy", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/shortenUrl/${existingShortUrl}`)
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
        it("should successfully create a new shortened URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url: uniqueUrl() })
                .expect(201);

            expect(response.body).toHaveProperty(
                "message",
                Responses.ShortenUrl.urlShortenedSuccess
            );
        });

        it("should return the already existing short URL if user tries to shorten an URL that already exists", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url: existingUrl })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.alreadyShortened);
        });

        it("shouldn't shorten URIs with unsupported protocols", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url: TestData.ShortUrlData.unsupportedProtocol })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });

        it("shouldn't shorten an URL with spaces", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url: TestData.ShortUrlData.containsSpaces })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });
    });

    describe("DELETE /shortenUrl/delete", (): void => {
        let other: TestUser;
        let shortUrl: string;
        let otherShortUrl: string;
        let ownedShortUrl: string;

        beforeAll(async (): Promise<void> => {
            other = await createTestUser();

            shortUrl = await createShortUrl(owner.cookie);
            otherShortUrl = await createShortUrl(other.cookie);
            ownedShortUrl = await createShortUrl(other.cookie);
        }, 25000);

        it("should not delete another user's short link", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", other.cookie)
                .send({ shortenedUrl: shortUrl })
                .expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.ShortenUrl.notAuthorizedToDelete
            );

            await request(TestData.apiURL).get(`/r/${shortUrl}`).expect(302);
        });

        it("should let the superuser delete another user's short link", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", TestData.superuser.cookie)
                .send({ shortenedUrl: otherShortUrl })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.urlDeletedSuccess);

            await request(TestData.apiURL).get(`/r/${otherShortUrl}`).expect(404);
        });

        it("should return 400 for a missing short code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", other.cookie)
                .send({})
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.missingShortenedUrl);
        });

        it("should return 404 for an unknown short code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", other.cookie)
                .send({ shortenedUrl: "nonExistent" })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);
        });

        it("should delete the short link for its owner", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", other.cookie)
                .send({ shortenedUrl: ownedShortUrl })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.urlDeletedSuccess);

            await request(TestData.apiURL).get(`/r/${ownedShortUrl}`).expect(404);
        });
    });
});
