import request from "supertest";
import supertest from "supertest";
import { OWNER_SEARCH_MAX_USERS } from "../constants/limits";
import { TestData } from "../constants/testData";
import { TestUser, createTestUser, randomHex, registerTestUser } from "./helpers/testUsers";

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const addContent = async (owner: TestUser): Promise<Record<string, string>> => {
    const upload: supertest.Response = await request(TestData.apiURL)
        .post("/upload")
        .set("Cookie", owner.cookie)
        .attach("file", testPng, `${randomHex(4)}.png`)
        .expect(201);

    const shortUrl: supertest.Response = await request(TestData.apiURL)
        .post("/shortenUrl")
        .set("Cookie", owner.cookie)
        .send({ url: `https://${TestData.runId}-${randomHex(8)}.vb2007.test/` })
        .expect(201);

    const paste: supertest.Response = await request(TestData.apiURL)
        .post("/paste")
        .set("Cookie", owner.cookie)
        .send({ paste: `paste ${randomHex(8)}` })
        .expect(201);

    return {
        uploads: upload.body.upload.id,
        "short-urls": shortUrl.body.data.shortenedUrl,
        pastes: paste.body.paste._id
    };
};

const lists: { path: string; field: string; idOf: (item: any) => string }[] = [
    { path: "uploads", field: "uploads", idOf: (item: any): string => item.id },
    { path: "short-urls", field: "shortUrls", idOf: (item: any): string => item.shortenedUrl },
    { path: "pastes", field: "pastes", idOf: (item: any): string => item.id }
];

describe("Admin owner search", (): void => {
    const prefix: string = `kz${randomHex(2)}`;
    let lastInCap: TestUser;
    let pastCap: TestUser;
    let shortOwner: TestUser;
    let lastInCapContent: Record<string, string>;
    let pastCapContent: Record<string, string>;
    let shortContent: Record<string, string>;

    beforeAll(async (): Promise<void> => {
        const inCap: TestUser[] = await Promise.all(
            Array.from({ length: OWNER_SEARCH_MAX_USERS - 1 }, () => createTestUser(prefix))
        );

        lastInCap = inCap.reduce((last, user) => (user.id > last.id ? user : last));
        pastCap = await createTestUser(prefix);
        shortOwner = await registerTestUser(`${prefix}${randomHex(1)}`);

        lastInCapContent = await addContent(lastInCap);
        pastCapContent = await addContent(pastCap);
        shortContent = await addContent(shortOwner);
    });

    describe.each(lists)("GET /admin/$path", ({ path, field, idOf }): void => {
        const list = (q: string): supertest.Test =>
            request(TestData.apiURL)
                .get(`/admin/${path}?q=${q}`)
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);

        it("should only match the shortest matching usernames, oldest first", async (): Promise<void> => {
            const response: supertest.Response = await list(prefix);

            expect(response.body[field].map(idOf).sort()).toEqual(
                [lastInCapContent[path], shortContent[path]].sort()
            );
            expect(response.body.pagination.total).toBe(2);
        });

        it("should still match a full username past the cap", async (): Promise<void> => {
            const response: supertest.Response = await list(pastCap.username);

            expect(response.body[field].map(idOf)).toEqual([pastCapContent[path]]);
            expect(response.body.pagination.total).toBe(1);
        });
    });
});
