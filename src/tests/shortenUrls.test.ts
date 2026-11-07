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
        .post("/shortenUrl")
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
    });

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

    describe("POST /shortenUrl", (): void => {
        it("should successfully create a new shortened URL", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
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
                .post("/shortenUrl")
                .set("Cookie", owner.cookie)
                .send({ url: existingUrl })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.alreadyShortened);
        });

        it("shouldn't shorten URIs with unsupported protocols", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
                .set("Cookie", owner.cookie)
                .send({ url: TestData.ShortUrlData.unsupportedProtocol })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });

        it("shouldn't shorten an URL with spaces", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
                .set("Cookie", owner.cookie)
                .send({ url: TestData.ShortUrlData.containsSpaces })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.invalidUrl);
        });

        it("shouldn't shorten an URL longer than the limit", async (): Promise<void> => {
            const url: string = uniqueUrlOfLength(SHORT_URL_MAX_LENGTH + 1);
            expect(url).toHaveLength(SHORT_URL_MAX_LENGTH + 1);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
                .set("Cookie", owner.cookie)
                .send({ url })
                .expect(400);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlTooLong);
        });

        it("should shorten an URL exactly as long as the limit", async (): Promise<void> => {
            const url: string = uniqueUrlOfLength(SHORT_URL_MAX_LENGTH);
            expect(url).toHaveLength(SHORT_URL_MAX_LENGTH);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
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
        });

        it("should give each user their own short link", async (): Promise<void> => {
            expect(secondShortUrl).not.toBe(firstShortUrl);
            expect(await addedByOf(firstShortUrl)).toBe(first.id);
            expect(await addedByOf(secondShortUrl)).toBe(second.id);
        });

        it("should return the user's own existing short link when they shorten the URL again", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl")
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
                        .post("/shortenUrl")
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
                .delete(`/shortenUrl/${firstShortUrl}`)
                .set("Cookie", first.cookie)
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
        });
    });

    describe("DELETE /shortenUrl/:shortenedUrl", (): void => {
        let other: TestUser;
        let shortUrl: string;
        let otherShortUrl: string;
        let ownedShortUrl: string;
        let pathShortUrl: string;

        beforeAll(async (): Promise<void> => {
            other = await createTestUser();

            shortUrl = await createShortUrl(owner.cookie);
            otherShortUrl = await createShortUrl(other.cookie);
            ownedShortUrl = await createShortUrl(other.cookie);
            pathShortUrl = await createShortUrl(other.cookie);
        });

        it("should not delete another user's short link", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/shortenUrl/${shortUrl}`)
                .set("Cookie", other.cookie)
                .expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.ShortenUrl.notAuthorizedToDelete
            );

            await request(TestData.apiURL).get(`/r/${shortUrl}`).expect(302);
        });

        it("should let the superuser delete another user's short link", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/shortenUrl/${otherShortUrl}`)
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.urlDeletedSuccess);

            await request(TestData.apiURL).get(`/r/${otherShortUrl}`).expect(404);
        });

        it("should return 404 for an unknown short code", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/nonExistent")
                .set("Cookie", other.cookie)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);
        });

        it("should require a login", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/shortenUrl/${shortUrl}`)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);

            await request(TestData.apiURL).get(`/r/${shortUrl}`).expect(302);
        });

        it("should delete the short code in the path, not one in the body", async (): Promise<void> => {
            await request(TestData.apiURL)
                .delete(`/shortenUrl/${pathShortUrl}`)
                .set("Cookie", other.cookie)
                .send({ shortenedUrl: shortUrl })
                .expect(200);

            await request(TestData.apiURL).get(`/r/${pathShortUrl}`).expect(404);
            await request(TestData.apiURL).get(`/r/${shortUrl}`).expect(302);
        });

        it("should delete the short link for its owner", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/shortenUrl/${ownedShortUrl}`)
                .set("Cookie", other.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.ShortenUrl.urlDeletedSuccess);

            await request(TestData.apiURL).get(`/r/${ownedShortUrl}`).expect(404);
        });
    });

    describe("Removed POST /shortenUrl/create and DELETE /shortenUrl/delete", (): void => {
        let shortUrl: string;

        beforeAll(async (): Promise<void> => {
            shortUrl = await createShortUrl(owner.cookie);
        });

        it("should answer 404 to POST /shortenUrl/create", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/shortenUrl/create")
                .set("Cookie", owner.cookie)
                .send({ url: uniqueUrl() })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.routeNotFound);
        });

        it("should answer 404 to DELETE /shortenUrl/delete", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/shortenUrl/delete")
                .set("Cookie", owner.cookie)
                .send({ shortenedUrl: shortUrl })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.ShortenUrl.urlNotFound);

            await request(TestData.apiURL).get(`/r/${shortUrl}`).expect(302);
        });
    });

    describe("GET /shortenUrls", (): void => {
        const metacharacterPath: string = "a+b(c)[d]*";
        const urls: string[] = [
            uniqueUrl(),
            uniqueUrl(),
            `${uniqueUrl()}${metacharacterPath}`,
            uniqueUrl(),
            uniqueUrl()
        ];
        let lister: TestUser;
        let other: TestUser;
        let codes: string[];
        let otherUrl: string;
        let otherCode: string;

        const listShortUrls = (query: string, cookie: string = lister.cookie): supertest.Test =>
            request(TestData.apiURL).get(`/shortenUrls?${query}`).set("Cookie", cookie);

        const codesOf = (response: supertest.Response): string[] =>
            response.body.shortUrls.map(
                ({ shortenedUrl }: { shortenedUrl: string }) => shortenedUrl
            );

        beforeAll(async (): Promise<void> => {
            [lister, other] = await Promise.all([createTestUser("sl"), createTestUser("sl")]);

            codes = [];
            for (const url of urls) {
                codes.push(await createShortUrl(lister.cookie, url));
            }

            otherUrl = uniqueUrl();
            otherCode = await createShortUrl(other.cookie, otherUrl);
        });

        it("should return 403 when logged out", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/shortenUrls")
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should list only the user's own short links, newest first by default", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls("").expect(200);

            expect(codesOf(response)).toEqual([...codes].reverse());
            expect(codesOf(response)).not.toContain(otherCode);
            expect(response.body.pagination).toEqual({
                limit: 10,
                page: 1,
                total: urls.length,
                pages: 1,
                sortBy: "addedOn",
                sortOrder: "desc"
            });
        });

        it("should only return the code, target and date of each short link", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls("sortOrder=asc").expect(200);

            expect(response.body.shortUrls[0]).toEqual({
                shortenedUrl: codes[0],
                originalUrl: urls[0],
                addedOn: expect.any(String)
            });
        });

        it("should never show another user's short links", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${encodeURIComponent(otherUrl)}`
            ).expect(200);

            expect(response.body.shortUrls).toEqual([]);
            expect(response.body.pagination).toMatchObject({ total: 0, pages: 0 });

            const otherResponse: supertest.Response = await listShortUrls("", other.cookie).expect(
                200
            );

            expect(codesOf(otherResponse)).toEqual([otherCode]);
        });

        it("should list oldest first with sortOrder=asc", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls("sortOrder=asc").expect(200);

            expect(codesOf(response)).toEqual(codes);
            expect(response.body.pagination).toMatchObject({ sortOrder: "asc" });
        });

        it.each(["asc", "desc"])(
            "should page through the short links in %s order",
            async (sortOrder: string): Promise<void> => {
                const pages: supertest.Response[] = await Promise.all(
                    [1, 2, 3].map((page: number) =>
                        listShortUrls(`sortOrder=${sortOrder}&limit=2&page=${page}`).expect(200)
                    )
                );
                const ordered: string[] = sortOrder === "asc" ? codes : [...codes].reverse();

                expect(pages.map(codesOf)).toEqual([
                    ordered.slice(0, 2),
                    ordered.slice(2, 4),
                    ordered.slice(4)
                ]);
                pages.forEach((page: supertest.Response, index: number) =>
                    expect(page.body.pagination).toEqual({
                        limit: 2,
                        page: index + 1,
                        total: urls.length,
                        pages: 3,
                        sortBy: "addedOn",
                        sortOrder
                    })
                );
            }
        );

        it("should return no short links past the last page", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls("limit=2&page=4").expect(200);

            expect(response.body.shortUrls).toEqual([]);
            expect(response.body.pagination).toMatchObject({
                page: 4,
                total: urls.length,
                pages: 3
            });
        });

        it("should find a short link by its code, ignoring case", async (): Promise<void> => {
            const response: supertest.Response = await listShortUrls(
                `q=${codes[1].toLowerCase()}`
            ).expect(200);

            expect(codesOf(response)).toEqual([codes[1]]);
            expect(response.body.pagination).toMatchObject({ total: 1, pages: 1 });
        });

        it("should find a short link by its target, ignoring case", async (): Promise<void> => {
            const host: string = new URL(urls[3]).hostname.split(".")[0];

            const response: supertest.Response = await listShortUrls(
                `q=${encodeURIComponent(host.toUpperCase())}`
            ).expect(200);

            expect(codesOf(response)).toEqual([codes[3]]);
        });

        it("should treat regex metacharacters in q literally", async (): Promise<void> => {
            const literal: supertest.Response = await listShortUrls(
                `q=${encodeURIComponent(metacharacterPath)}`
            ).expect(200);

            expect(codesOf(literal)).toEqual([codes[2]]);

            for (const pattern of [".*", "^https", "[a-z]+"]) {
                const response: supertest.Response = await listShortUrls(
                    `q=${encodeURIComponent(pattern)}`
                ).expect(200);

                expect(response.body.shortUrls).toEqual([]);
            }
        });

        it.each([
            ["page", "page=0"],
            ["page", "page=-1"],
            ["page", "page=1.5"],
            ["page", "page=1&page=2"],
            ["limit", "limit="],
            ["limit", "limit=0"],
            ["limit", "limit=51"],
            ["limit", "limit=abc"],
            ["sortBy", "sortBy=shortenedUrl"],
            ["sortOrder", "sortOrder=sideways"],
            ["sortOrder", "sortOrder=asc&sortOrder=desc"],
            ["q", `q=${"a".repeat(101)}`],
            ["q", "q=a&q=b"],
            ["q", "q[$ne]=x"],
            ["q", "q=%00"],
            ["q", "q=a%00b"]
        ])(
            "should return 400 for an invalid %s (%s)",
            async (param: string, query: string): Promise<void> => {
                const response: supertest.Response = await listShortUrls(query)
                    .expect("Content-Type", /json/)
                    .expect(400);

                expect(response.body).toEqual({ error: Responses.invalidQuery(param) });
            }
        );
    });
});
