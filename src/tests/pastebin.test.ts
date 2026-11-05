import request from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { PASTE_MAX_LENGTH, PASTE_MIN_LENGTH } from "../constants/limits";
import { TestUser, createTestUser } from "./helpers/testUsers";
import supertest from "supertest";

const createPaste = async (cookie: string, body: Record<string, unknown>): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/paste")
        .set("Cookie", cookie)
        .send(body);

    expect(response.status).toBe(201);

    return response.body.paste._id;
};

describe("Pastebin API Tests", (): void => {
    const superuserCookie: string = TestData.superuser.cookie;
    let owner: TestUser;

    beforeAll(async (): Promise<void> => {
        owner = await createTestUser();
    }, 25000);

    describe("GET /paste/:id", (): void => {
        let testPasteId: string;

        beforeAll(async (): Promise<void> => {
            testPasteId = await createPaste(owner.cookie, {
                paste: TestData.PastebinData.testPasteContent
            });
        });

        it("should return a paste when given a valid ID", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${testPasteId}`)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body).toHaveProperty("paste");
            expect(response.body.paste.content).toBe(TestData.PastebinData.testPasteContent);
            expect(response.body.paste._id).toBe(testPasteId);
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
        it("should create a new paste when authenticated", async (): Promise<void> => {
            const pasteContent: string = "New paste content for testing";

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .set("Cookie", owner.cookie)
                .send({ paste: pasteContent })
                .expect("Content-Type", /json/)
                .expect(201);

            expect(response.body).toHaveProperty("message", Responses.Pastebin.pasteCreatedSuccess);
            expect(response.body.paste.content).toBe(pasteContent);
        });

        it("should reject paste creation when not authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .send({ paste: "Unauthorized paste content" })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it.each([{}, [], { paste: "" }, { paste: 123 }, { paste: ["x"] }])(
            "should reject the body %p without a paste",
            async (body: object): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/paste")
                    .set("Cookie", owner.cookie)
                    .send(body)
                    .expect("Content-Type", /json/)
                    .expect(400);

                expect(response.body).toEqual({ error: Responses.Pastebin.missingPaste });
            }
        );

        it("should reject a request without a body", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .set("Cookie", owner.cookie)
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: Responses.Pastebin.missingPaste });
        });

        it.each([PASTE_MIN_LENGTH - 1, PASTE_MAX_LENGTH + 1])(
            "should reject a paste of %p characters",
            async (length: number): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/paste")
                    .set("Cookie", owner.cookie)
                    .send({ paste: "a".repeat(length) })
                    .expect("Content-Type", /json/)
                    .expect(400);

                expect(response.body).toEqual({ error: Responses.Pastebin.invalidPasteLength });
            }
        );

        it.each([PASTE_MIN_LENGTH, PASTE_MAX_LENGTH])(
            "should accept a paste of %p characters",
            async (length: number): Promise<void> => {
                const paste: string = "x".repeat(length);

                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/paste")
                    .set("Cookie", owner.cookie)
                    .send({ paste })
                    .expect(201);

                expect(response.body.paste.content).toBe(paste);
            }
        );
    });

    describe("Paste language", (): void => {
        let languagePasteId: string;

        it("should create a paste with a language", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .set("Cookie", owner.cookie)
                .send({ paste: "print('hello')", language: "python" })
                .expect(201);

            languagePasteId = response.body.paste._id;

            expect(response.body).toHaveProperty("message", Responses.Pastebin.pasteCreatedSuccess);
            expect(response.body.paste.language).toBe("python");
        });

        it("should create a paste without a language", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/paste")
                .set("Cookie", owner.cookie)
                .send({ paste: "Paste without a language" })
                .expect(201);

            expect(response.body.paste).not.toHaveProperty("language");
        });

        it.each(["Not Valid!", 123])(
            "should reject the invalid language %p",
            async (language: string | number): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/paste")
                    .set("Cookie", owner.cookie)
                    .send({ paste: "Paste with an invalid language", language })
                    .expect(400);

                expect(response.body).toHaveProperty("error", Responses.Pastebin.invalidLanguage);
            }
        );

        it("should return the language from GET /paste/:id", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${languagePasteId}`)
                .expect(200);

            expect(response.body.paste.language).toBe("python");
        });

        it("should return the language from GET /pastes/:username", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/pastes/${owner.username}?sortBy=addedOn&sortOrder=desc&limit=50`)
                .set("Cookie", owner.cookie)
                .expect(200);

            const paste = response.body.pastes.find(
                (paste: { _id: string }): boolean => paste._id === languagePasteId
            );

            expect(paste).toHaveProperty("language", "python");
        });
    });

    describe("GET /pastes/:username", (): void => {
        it("should get pastes by username when authenticated", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/pastes/${owner.username}`)
                .set("Cookie", owner.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("pastes");
            expect(response.body).toHaveProperty("pagination");
            expect(Array.isArray(response.body.pastes)).toBe(true);
        });

        describe("query parameters", (): void => {
            let lister: TestUser;
            let pasteIds: string[];

            const listPastes = (query: string): supertest.Test =>
                request(TestData.apiURL)
                    .get(`/pastes/${lister.username}?${query}`)
                    .set("Cookie", lister.cookie);

            const idsOf = (response: supertest.Response): string[] =>
                response.body.pastes.map((paste: { _id: string }): string => paste._id);

            beforeAll(async (): Promise<void> => {
                lister = await createTestUser("pl");
                pasteIds = [];

                for (const paste of ["First listed paste", "Second listed paste", "Third one"]) {
                    pasteIds.push(await createPaste(lister.cookie, { paste }));
                }
            }, 25000);

            it("should use the defaults without parameters", async (): Promise<void> => {
                const response: supertest.Response = await listPastes("").expect(200);

                expect(idsOf(response)).toEqual([...pasteIds].reverse());
                expect(response.body.pagination).toEqual({
                    limit: 10,
                    page: 1,
                    total: 3,
                    pages: 1,
                    sortBy: "addedOn",
                    sortOrder: "desc"
                });
            });

            it("should accept valid parameters", async (): Promise<void> => {
                const response: supertest.Response = await listPastes(
                    "limit=10&page=1&sortBy=addedOn&sortOrder=asc"
                ).expect(200);

                expect(idsOf(response)).toEqual(pasteIds);
                expect(response.body.pagination).toEqual({
                    limit: 10,
                    page: 1,
                    total: 3,
                    pages: 1,
                    sortBy: "addedOn",
                    sortOrder: "asc"
                });
            });

            it("should return no pastes past the last page", async (): Promise<void> => {
                const response: supertest.Response = await listPastes(
                    `limit=50&page=${Number.MAX_SAFE_INTEGER}`
                ).expect(200);

                expect(response.body.pastes).toEqual([]);
                expect(response.body.pagination).toEqual({
                    limit: 50,
                    page: Number.MAX_SAFE_INTEGER,
                    total: 3,
                    pages: 1,
                    sortBy: "addedOn",
                    sortOrder: "desc"
                });
            });

            it.each(["asc", "desc"])(
                "should page through the pastes in %s order",
                async (sortOrder: string): Promise<void> => {
                    const firstPage: supertest.Response = await listPastes(
                        `sortOrder=${sortOrder}&limit=2&page=1`
                    ).expect(200);
                    const lastPage: supertest.Response = await listPastes(
                        `sortOrder=${sortOrder}&limit=2&page=2`
                    ).expect(200);

                    const ordered: string[] =
                        sortOrder === "asc" ? pasteIds : [...pasteIds].reverse();

                    expect([...idsOf(firstPage), ...idsOf(lastPage)]).toEqual(ordered);
                    expect(lastPage.body.pagination).toMatchObject({ page: 2, total: 3, pages: 2 });
                }
            );

            it.each([
                ["page", "page=-5"],
                ["page", "page=0"],
                ["page", "page=1.5"],
                ["page", "page=1&page=2"],
                ["page", "page=9007199254740992"],
                ["limit", "limit="],
                ["limit", "limit=1.5"],
                ["limit", "limit=0"],
                ["limit", "limit=51"],
                ["limit", "limit=abc"],
                ["sortBy", "sortBy=$where"],
                ["sortBy", "sortBy[a]=1"],
                ["sortOrder", "sortOrder=sideways"],
                ["sortOrder", "sortOrder=asc&sortOrder=desc"]
            ])(
                "should return 400 for an invalid %s (%s)",
                async (param: string, query: string): Promise<void> => {
                    const response: supertest.Response = await listPastes(query)
                        .expect("Content-Type", /json/)
                        .expect(400);

                    expect(response.body).toEqual({
                        error: Responses.Pastebin.invalidQuery(param)
                    });
                }
            );
        });
    });

    describe("PATCH /paste/:id", (): void => {
        let pasteOwner: TestUser;
        let other: TestUser;
        let pasteId: string;

        const getPasteLanguage = async (): Promise<string> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${pasteId}`)
                .expect(200);

            return response.body.paste.language;
        };

        beforeAll(async (): Promise<void> => {
            pasteOwner = await createTestUser();
            other = await createTestUser();

            pasteId = await createPaste(pasteOwner.cookie, {
                paste: "Paste content for language updates",
                language: "python"
            });
        }, 25000);

        it("should let the owner change the language", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/paste/${pasteId}`)
                .set("Cookie", pasteOwner.cookie)
                .send({ language: "typescript" })
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body.message).toBe(Responses.Pastebin.pasteUpdatedSuccess);
            expect(response.body.paste.language).toBe("typescript");
            expect(await getPasteLanguage()).toBe("typescript");
        });

        it("should not let another user change the language", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/paste/${pasteId}`)
                .set("Cookie", other.cookie)
                .send({ language: "rust" })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);
            expect(await getPasteLanguage()).toBe("typescript");
        });

        it("should let the superuser change another user's paste", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/paste/${pasteId}`)
                .set("Cookie", superuserCookie)
                .send({ language: "go" })
                .expect(200);

            expect(response.body.message).toBe(Responses.Pastebin.pasteUpdatedSuccess);
            expect(response.body.paste.language).toBe("go");
        });

        it.each([{ language: "Not Valid!" }, {}])(
            "should reject the invalid body %p",
            async (body: { language?: string }): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .patch(`/paste/${pasteId}`)
                    .set("Cookie", pasteOwner.cookie)
                    .send(body)
                    .expect(400);

                expect(response.body).toHaveProperty("error", Responses.Pastebin.invalidLanguage);
            }
        );

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            await request(TestData.apiURL)
                .patch("/paste/abc")
                .set("Cookie", superuserCookie)
                .send({ language: "go" })
                .expect(400);
        });

        it("should return 404 for non-existing paste ID", async (): Promise<void> => {
            const nonExistingId: string = new mongoose.Types.ObjectId().toString();

            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/paste/${nonExistingId}`)
                .set("Cookie", superuserCookie)
                .send({ language: "go" })
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.Pastebin.pasteNotFound);
        });

        it("should return the owner's username from GET /paste/:id", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${pasteId}`)
                .expect(200);

            expect(response.body.paste.addedBy.username).toBe(pasteOwner.username);
        });
    });

    describe("DELETE /paste/:id", (): void => {
        let other: TestUser;
        let pasteId: string;
        let otherPasteId: string;

        const pasteContent: string = "Paste content for ownership testing";

        beforeAll(async (): Promise<void> => {
            other = await createTestUser();

            pasteId = await createPaste(owner.cookie, { paste: pasteContent });
            otherPasteId = await createPaste(other.cookie, { paste: pasteContent });
        }, 25000);

        it("should not delete another user's paste", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${pasteId}`)
                .set("Cookie", other.cookie)
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notAuthorized);

            const getResponse: supertest.Response = await request(TestData.apiURL)
                .get(`/paste/${pasteId}`)
                .expect(200);

            expect(getResponse.body.paste.content).toBe(pasteContent);
        });

        it("should let the superuser delete another user's paste", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${otherPasteId}`)
                .set("Cookie", superuserCookie)
                .expect(200);

            expect(response.body.message).toBe(Responses.Pastebin.pasteDeletedSuccess);
            expect(response.body.paste).toEqual({ id: otherPasteId });

            await request(TestData.apiURL).get(`/paste/${otherPasteId}`).expect(404);
        });

        it("should return 400 for a malformed ID", async (): Promise<void> => {
            await request(TestData.apiURL)
                .delete("/paste/abc")
                .set("Cookie", superuserCookie)
                .expect(400);
        });

        it("should return 404 for non-existing paste ID", async (): Promise<void> => {
            const nonExistingId: string = new mongoose.Types.ObjectId().toString();

            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${nonExistingId}`)
                .set("Cookie", superuserCookie)
                .expect(404);

            expect(response.body).toHaveProperty("error", Responses.Pastebin.pasteNotFound);
        });

        it("should delete the paste for its owner", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/paste/${pasteId}`)
                .set("Cookie", owner.cookie)
                .expect("Content-Type", /json/)
                .expect(200);

            expect(response.body.message).toBe(Responses.Pastebin.pasteDeletedSuccess);
            expect(response.body.paste).toEqual({ id: pasteId });

            await request(TestData.apiURL).get(`/paste/${pasteId}`).expect(404);
        });
    });
});
