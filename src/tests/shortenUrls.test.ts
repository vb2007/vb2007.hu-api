import request from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { SHORT_URL_CODE_LENGTH, SHORT_URL_MAX_LENGTH } from "../constants/limits";
import { TestUser, createTestUser, randomHex } from "./helpers/testUsers";
import supertest from "supertest";

const uniqueUrl = (): string => `https://${TestData.runId}-${randomHex(8)}.vb2007.test/`;

const uniqueUrlOfLength = (length: number): string => uniqueUrl().padEnd(length, "a");

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

        it("should give a new short link a code of the configured length", async (): Promise<void> => {
            const shortenedUrl: string = await createShortUrl(owner.cookie);

            expect(shortenedUrl).toMatch(new RegExp(`^[0-9a-zA-Z]{${SHORT_URL_CODE_LENGTH}}$`));
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

        it("shouldn't shorten an URL longer than the limit", async (): Promise<void> => {
            const url: string = uniqueUrlOfLength(SHORT_URL_MAX_LENGTH + 1);
            expect(url).toHaveLength(SHORT_URL_MAX_LENGTH + 1);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlTooLong);
        });

        it("should shorten an URL exactly as long as the limit", async (): Promise<void> => {
            const url: string = uniqueUrlOfLength(SHORT_URL_MAX_LENGTH);
            expect(url).toHaveLength(SHORT_URL_MAX_LENGTH);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url })
                .expect(201);

            expect(response.body.data).toHaveProperty("originalUrl", url);
        });
    });

    describe("Short links of different users for the same URL", (): void => {
        const sharedUrl: string = uniqueUrl();
        let first: TestUser;
        let second: TestUser;
        let firstShortUrl: string;
        let secondShortUrl: string;

        const addedByOf = async (shortenedUrl: string): Promise<string> =>
            (await request(TestData.apiURL).get(`/shortenUrl/${shortenedUrl}`).expect(200)).body
                .addedBy._id;

        beforeAll(async (): Promise<void> => {
            [first, second] = await Promise.all([createTestUser("su"), createTestUser("su")]);

            firstShortUrl = await createShortUrl(first.cookie, sharedUrl);
            secondShortUrl = await createShortUrl(second.cookie, sharedUrl);
        }, 25000);

        it("should give each user their own short link", async (): Promise<void> => {
            expect(secondShortUrl).not.toBe(firstShortUrl);
            expect(await addedByOf(firstShortUrl)).toBe(first.id);
            expect(await addedByOf(secondShortUrl)).toBe(second.id);
        });

        it("should return the user's own existing short link when they shorten the URL again", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", first.cookie)
                .send({ url: sharedUrl })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.alreadyShortened);
            expect(response.body.data).toMatchObject({
                shortenedUrl: firstShortUrl,
                originalUrl: sharedUrl,
                addedBy: first.id
            });
        });

        it("should return one short link to concurrent requests of the same user", async (): Promise<void> => {
            const url: string = uniqueUrl();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 20 }, () =>
                    request(TestData.apiURL)
                        .post("/shortenUrl/create")
                        .set("Cookie", first.cookie)
                        .send({ url })
                )
            );

            expect(responses.map(({ status }) => status).sort()).toEqual([
                ...Array(19).fill(200),
                201
            ]);
            expect(new Set(responses.map(({ body }) => body.data.shortenedUrl)).size).toBe(1);
        });

        it("should keep another user's short link working after one is deleted", async (): Promise<void> => {
            await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", first.cookie)
                .send({ shortenedUrl: firstShortUrl })
                .expect(200);

            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/r/${secondShortUrl}`)
                .expect(302);

            expect(response.headers.location).toBe(sharedUrl);
        });

        it("should keep another user's short link working after an account is deleted", async (): Promise<void> => {
            const url: string = uniqueUrl();
            const deleted: TestUser = await createTestUser("su");
            await createShortUrl(deleted.cookie, url);
            const keptShortUrl: string = await createShortUrl(second.cookie, url);

            await request(TestData.apiURL)
                .delete("/user")
                .set("Cookie", deleted.cookie)
                .send({ password: deleted.password })
                .expect(200);

            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/r/${keptShortUrl}`)
                .expect(302);

            expect(response.headers.location).toBe(url);
        }, 25000);
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
