import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { newObjectId } from "../helpers/prisma";
import {
    TestUser,
    createTestUser,
    isStored,
    randomHex,
    storedAuthentication,
    updateStoredUser
} from "./helpers/testUsers";

const revokeKeys = (id: string, cookie: string = TestData.superuser.cookie): supertest.Test =>
    request(TestData.apiURL).delete(`/admin/users/${id}/api-keys`).set("Cookie", cookie);

const seedKeys = async (user: TestUser, count: number) => {
    const apiKeys = Array.from({ length: count }, (_, index: number) => ({
        id: randomHex(16),
        name: `seeded ${index}`,
        hash: randomHex(32),
        hint: "abcd",
        scopes: ["pastes:read"],
        createdAt: new Date(),
        expiresAt: null as Date | null,
        lastUsedAt: null as Date | null
    }));
    await updateStoredUser(user.id, (f) => [f("authentication.apiKeys").set(apiKeys)]);

    return apiKeys;
};

describe("GET /admin/users/:id API keys", (): void => {
    it("should list the user's keys like GET /user/api-keys, without their hashes", async (): Promise<void> => {
        const user: TestUser = await createTestUser("aakd");
        const [seeded] = await seedKeys(user, 1);

        const response: supertest.Response = await request(TestData.apiURL)
            .get(`/admin/users/${user.id}`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);
        const own: supertest.Response = await request(TestData.apiURL)
            .get("/user/api-keys")
            .set("Cookie", user.cookie)
            .expect(200);

        expect(response.body.user.apiKeys).toEqual(own.body.apiKeys);
        expect(response.body.user.apiKeys).toEqual([
            {
                id: seeded.id,
                name: seeded.name,
                hint: seeded.hint,
                scopes: seeded.scopes,
                createdAt: seeded.createdAt.toISOString(),
                expiresAt: null,
                lastUsedAt: null
            }
        ]);
        expect(response.text).not.toContain(seeded.hash);
    });

    it("should list no keys for a user without any", async (): Promise<void> => {
        const user: TestUser = await createTestUser("aake");

        const response: supertest.Response = await request(TestData.apiURL)
            .get(`/admin/users/${user.id}`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);

        expect(response.body.user.apiKeys).toEqual([]);
    });
});

describe("DELETE /admin/users/:id/api-keys", (): void => {
    it("should revoke every key and keep the user's session", async (): Promise<void> => {
        const user: TestUser = await createTestUser("aakr");
        await seedKeys(user, 2);

        const response: supertest.Response = await revokeKeys(user.id).expect(200);
        expect(response.body).toEqual({
            message: Responses.Admin.userApiKeysRevokedSuccess,
            user: { id: user.id, username: user.username },
            revoked: 2
        });

        expect(await isStored(user.id, "authentication.apiKeys")).toBe(false);
        await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(200);

        const again: supertest.Response = await revokeKeys(user.id).expect(200);
        expect(again.body.revoked).toBe(0);
    });

    it("should reject a user who isn't the superuser", async (): Promise<void> => {
        const user: TestUser = await createTestUser("aakf");
        const [seeded] = await seedKeys(user, 1);

        const response: supertest.Response = await revokeKeys(user.id, user.cookie).expect(403);
        expect(response.body).toEqual({ error: Responses.notAuthorized });
        expect((await storedAuthentication(user.id)).apiKeys).toMatchObject([
            { id: seeded.id, hash: seeded.hash }
        ]);
    });

    it("should answer 403 without a session", async (): Promise<void> => {
        await request(TestData.apiURL).delete(`/admin/users/${newObjectId()}/api-keys`).expect(403);
    });

    it("should answer 404 for an unknown user", async (): Promise<void> => {
        const response: supertest.Response = await revokeKeys(newObjectId()).expect(404);
        expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
    });

    it("should answer 400 for an invalid id", async (): Promise<void> => {
        await revokeKeys("not-an-id").expect(400);
    });
});
