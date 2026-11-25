import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import express from "express";
import { API_KEY_SCOPES, FAILED_ATTEMPTS_PER_IP } from "../constants/limits";
import { apiKeyHintOf, createApiKeyId, createApiKeyToken, hashApiKey } from "../helpers/apiKeys";
import { githubCallback } from "../controllers/authentication";
import { parseCorsOrigins } from "../helpers/cors";
import { newObjectId } from "../helpers/prisma";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    storedAuthentication,
    updateStoredUser
} from "./helpers/testUsers";

type Method = "get" | "post" | "patch" | "put" | "delete";

interface SeededKey {
    id: string;
    token: string;
}

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const minuteMs: number = 60 * 1000;

const seedKey = async (
    userId: string,
    scopes: string[],
    fields: Record<string, unknown> = {}
): Promise<SeededKey> => {
    const token: string = createApiKeyToken();
    const id: string = createApiKeyId();

    await updateStoredUser(userId, (f) => [
        f("authentication.apiKeys").push({
            id,
            name: "auth test",
            hash: hashApiKey(token),
            hint: apiKeyHintOf(token),
            scopes,
            createdAt: new Date(),
            expiresAt: null,
            lastUsedAt: null,
            ...fields
        })
    ]);

    return { id, token };
};

const allScopesBut = (scope: string): string[] =>
    API_KEY_SCOPES.filter((candidate: string): boolean => candidate !== scope);

const withAuthorization = (
    method: Method,
    path: string,
    authorization: string,
    clientIp: string = isolatedClientIp()
): supertest.Test =>
    request(TestData.apiURL)
        [method](path)
        .set("Authorization", authorization)
        .set("X-Forwarded-For", clientIp);

const withKey = (method: Method, path: string, token: string, clientIp?: string): supertest.Test =>
    withAuthorization(method, path, `Bearer ${token}`, clientIp);

const expectRejectedKey = (response: supertest.Response): void => {
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(
        'Bearer realm="vb2007.hu", error="invalid_token"'
    );
    expect(response.body).toEqual({ error: Responses.ApiKeys.invalidApiKey });
};

const expectScopeMissing = (response: supertest.Response, scope: string): void => {
    expect(response.status).toBe(403);
    expect(response.headers["www-authenticate"]).toBe(
        `Bearer realm="vb2007.hu", error="insufficient_scope", scope="${scope}"`
    );
    expect(response.body).toEqual({ error: Responses.ApiKeys.apiKeyScopeMissing(scope) });
};

const expectPastAuthentication = (response: supertest.Response): void => {
    expect([401, 403, 429]).not.toContain(response.status);
};

const lastUsedAtOf = async (userId: string, apiKeyId: string): Promise<Date | undefined> =>
    (await storedAuthentication(userId)).apiKeys.find(({ id }) => id === apiKeyId)?.lastUsedAt;

const waitForLastUse = async (userId: string, apiKeyId: string, after: Date): Promise<Date> => {
    for (let attempt: number = 0; attempt < 50; attempt++) {
        const lastUsedAt: Date | undefined = await lastUsedAtOf(userId, apiKeyId);

        if (lastUsedAt && lastUsedAt > after) {
            return lastUsedAt;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("lastUsedAt was never set");
};

const contentRoutes: [Method, string, string][] = [
    ["get", "/user", "account:read"],
    ["patch", "/users/:userId", "account:write"],
    ["get", "/shortenUrls", "shortUrls:read"],
    ["post", "/shortenUrl", "shortUrls:write"],
    ["delete", "/shortenUrl/abcdef", "shortUrls:write"],
    ["get", "/pastes/:username", "pastes:read"],
    ["post", "/paste", "pastes:write"],
    ["patch", "/paste/:objectId", "pastes:write"],
    ["delete", "/paste/:objectId", "pastes:write"],
    ["get", "/uploads/usage", "uploads:read"],
    ["get", "/uploads", "uploads:read"],
    ["get", "/upload/:objectId", "uploads:read"],
    ["post", "/upload", "uploads:write"],
    ["patch", "/upload/:objectId", "uploads:write"],
    ["delete", "/upload/:objectId", "uploads:write"]
];

const adminRoutes: [Method, string][] = [
    ["get", "/admin/users"],
    ["get", "/admin/users/:objectId"],
    ["patch", "/admin/users/:objectId"],
    ["patch", "/admin/users/:objectId/upload-quota"],
    ["patch", "/admin/users/:objectId/suspension"],
    ["get", "/admin/users/:objectId/uploads"],
    ["get", "/admin/uploads"],
    ["get", "/admin/short-urls"],
    ["get", "/admin/mail-budget"],
    ["delete", "/admin/users/:objectId"],
    ["post", "/admin/users/:objectId/logout"],
    ["delete", "/admin/users/:objectId/mfa"],
    ["delete", "/admin/users/:objectId/api-keys"],
    ["get", "/admin/stats"],
    ["get", "/admin/pastes"],
    ["get", "/admin/pending-registrations"],
    ["delete", "/admin/pending-registrations/:objectId"]
];

const sessionOnlyRoutes: [Method, string][] = [
    ["post", "/user/password"],
    ["patch", "/user/password"],
    ["patch", "/user/email"],
    ["post", "/user/email/confirm"],
    ["delete", "/user"],
    ["put", "/user/mfa/email"],
    ["delete", "/user/mfa/email"],
    ["post", "/user/mfa/totp"],
    ["post", "/user/mfa/totp/confirm"],
    ["delete", "/user/mfa/totp"],
    ["post", "/user/mfa/recovery-codes"],
    ["post", "/user/passkeys/options"],
    ["post", "/user/passkeys"],
    ["get", "/user/passkeys"],
    ["patch", "/user/passkeys/abc"],
    ["delete", "/user/passkeys/abc"],
    ["post", "/auth/github/link"],
    ["delete", "/auth/github/link"],
    ["get", "/user/api-keys"],
    ["post", "/user/api-keys"],
    ["post", "/user/api-keys/:apiKeyId/rotate"],
    ["delete", "/user/api-keys/:apiKeyId"],
    ["post", "/auth/logout"],
    ["delete", "/admin/rate-limits"]
];

describe("API key authentication", (): void => {
    let owner: TestUser;
    let other: TestUser;
    let ownerKey: SeededKey;

    const pathOf = (path: string): string =>
        path
            .replace(":userId", owner.id)
            .replace(":username", owner.username)
            .replace(":objectId", newObjectId())
            .replace(":apiKeyId", ownerKey.id);

    beforeAll(async (): Promise<void> => {
        owner = await createTestUser("aka");
        other = await createTestUser("ako");
        ownerKey = await seedKey(owner.id, allScopesBut("admin:read"));
    });

    describe("scopes", (): void => {
        it.each(contentRoutes)(
            "should answer 403 to %s %s without %s",
            async (method: Method, path: string, scope: string): Promise<void> => {
                const { token } = await seedKey(owner.id, allScopesBut(scope));

                expectScopeMissing(await withKey(method, pathOf(path), token), scope);
            }
        );

        it.each(contentRoutes)(
            "should let %s %s through with %s",
            async (method: Method, path: string, scope: string): Promise<void> => {
                const { token } = await seedKey(owner.id, [scope]);

                expectPastAuthentication(await withKey(method, pathOf(path), token));
            }
        );

        it("should answer GET /user the same with a key as with the session", async (): Promise<void> => {
            const { token } = await seedKey(owner.id, ["account:read"]);
            const bySession: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", owner.cookie)
                .expect(200);

            const byKey: supertest.Response = await withKey("get", "/user", token).expect(200);

            expect(byKey.body).toEqual(bySession.body);
        });
    });

    describe("session-only routes", (): void => {
        it.each(sessionOnlyRoutes)(
            "should refuse a key on %s %s even next to a valid session",
            async (method: Method, path: string): Promise<void> => {
                const response: supertest.Response = await withKey(
                    method,
                    pathOf(path),
                    ownerKey.token
                ).set("Cookie", owner.cookie);

                expect(response.status).toBe(403);
                expect(response.body).toEqual({ error: Responses.ApiKeys.apiKeyNotAccepted });
            }
        );

        it("should keep the session after a refused logout", async (): Promise<void> => {
            await withKey("post", "/auth/logout", ownerKey.token)
                .set("Cookie", owner.cookie)
                .expect(403);

            await request(TestData.apiURL).get("/user").set("Cookie", owner.cookie).expect(200);
        });

        it("should log out without a session or key as before", async (): Promise<void> => {
            await request(TestData.apiURL).post("/auth/logout").expect(200);
        });

        it("should refuse to finish a GitHub link sent with a key", async (): Promise<void> => {
            const state: string = newObjectId();
            const res = { redirect: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() };

            await githubCallback(
                {
                    headers: { authorization: `Bearer ${ownerKey.token}` },
                    cookies: { "__Host-VB-OAUTH": { state, verifier: state, mode: "link" } },
                    query: { code: "code", state }
                } as unknown as express.Request,
                res as unknown as express.Response
            );

            expect(new URL(res.redirect.mock.calls[0][0]).searchParams.get("oauthError")).toBe(
                Responses.GithubOauth.apiKeyNotAccepted
            );
        });
    });

    describe("rejected keys", (): void => {
        const malformed: [string, string][] = [
            ["an empty header", ""],
            ["the scheme alone", "Bearer"],
            ["another scheme", `Basic ${createApiKeyToken()}`],
            ["two spaces", `Bearer  ${createApiKeyToken()}`],
            ["no prefix", `Bearer ${createApiKeyToken().slice(4)}`],
            ["a short token", `Bearer ${createApiKeyToken().slice(0, -1)}`],
            ["a long token", `Bearer ${createApiKeyToken()}A`],
            ["base64 characters", `Bearer vbk_${"+/".repeat(21)}A`],
            ["a session-like token", `Bearer ${"a".repeat(64)}`]
        ];

        it.each(malformed)(
            "should answer 401 to %s",
            async (_: string, authorization: string): Promise<void> => {
                expectRejectedKey(await withAuthorization("get", "/user", authorization));
            }
        );

        it("should answer 401 to an unknown key", async (): Promise<void> => {
            expectRejectedKey(await withKey("get", "/user", createApiKeyToken()));
        });

        it.each(["bearer", "BEARER", "bEaReR"])(
            "should take the scheme written as %s",
            async (scheme: string): Promise<void> => {
                const { token } = await seedKey(owner.id, ["account:read"]);

                await withAuthorization("get", "/user", `${scheme} ${token}`).expect(200);
            }
        );

        it("should answer 401 to more than one Authorization header, even with a valid key", async (): Promise<void> => {
            const { token } = await seedKey(owner.id, ["account:read"]);
            const valid: string = `Bearer ${token}`;

            for (const headers of [
                [valid, `Bearer ${createApiKeyToken()}`],
                [valid, valid]
            ]) {
                expectRejectedKey(
                    await request(TestData.apiURL)
                        .get("/user")
                        .set("Authorization", headers as unknown as string)
                        .set("X-Forwarded-For", isolatedClientIp())
                );
            }
        });

        it("should not fall back to a valid session when the key is bad or lacks the scope", async (): Promise<void> => {
            expectRejectedKey(
                await withKey("get", "/user", createApiKeyToken()).set("Cookie", owner.cookie)
            );

            const { token } = await seedKey(owner.id, ["pastes:read"]);
            expectScopeMissing(
                await withKey("get", "/user", token).set("Cookie", owner.cookie),
                "account:read"
            );
        });

        it("should refuse an expired key and accept a live one of the same account", async (): Promise<void> => {
            const expired: SeededKey = await seedKey(owner.id, ["account:read"], {
                expiresAt: new Date(Date.now() - 1000)
            });
            const live: SeededKey = await seedKey(owner.id, ["account:read"], {
                expiresAt: new Date(Date.now() + minuteMs)
            });

            expectRejectedKey(await withKey("get", "/user", expired.token));
            await withKey("get", "/user", live.token).expect(200);
        });

        it("should refuse the keys of a suspended account", async (): Promise<void> => {
            const suspended: TestUser = await createTestUser("aks");
            const { id, token } = await seedKey(suspended.id, ["account:read"]);
            await withKey("get", "/user", token).expect(200);

            await updateStoredUser(suspended.id, (f) => [f.suspendedAt.set(new Date())]);

            expectRejectedKey(await withKey("get", "/user", token));
            expect(
                (await storedAuthentication(suspended.id)).apiKeys.map((key) => key.id)
            ).toContain(id);
        });

        it("should refuse a deleted key and a rotated-out token", async (): Promise<void> => {
            const user: TestUser = await createTestUser("akr");
            const created: supertest.Response = await request(TestData.apiURL)
                .post("/user/api-keys")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ name: "CI", scopes: ["account:read"], password: user.password })
                .expect(201);
            const { id, token } = created.body.apiKey;
            await withKey("get", "/user", token).expect(200);

            const rotated: supertest.Response = await request(TestData.apiURL)
                .post(`/user/api-keys/${id}/rotate`)
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ password: user.password })
                .expect(200);

            expectRejectedKey(await withKey("get", "/user", token));
            await withKey("get", "/user", rotated.body.apiKey.token).expect(200);

            await request(TestData.apiURL)
                .delete(`/user/api-keys/${id}`)
                .set("Cookie", user.cookie)
                .expect(200);

            expectRejectedKey(await withKey("get", "/user", rotated.body.apiKey.token));
        });
    });

    describe("own resources", (): void => {
        it("should manage short URLs, pastes and uploads with a key", async (): Promise<void> => {
            const user: TestUser = await createTestUser("akc");
            const { token } = await seedKey(user.id, [
                "shortUrls:read",
                "shortUrls:write",
                "pastes:read",
                "pastes:write",
                "uploads:read",
                "uploads:write"
            ]);

            const shortUrl: string = (
                await withKey("post", "/shortenUrl", token)
                    .send({ url: `https://${TestData.runId}-${newObjectId()}.vb2007.test/` })
                    .expect(201)
            ).body.data.shortenedUrl;
            expect(
                (await withKey("get", "/shortenUrls", token).expect(200)).body.shortUrls.length
            ).toBe(1);
            await withKey("delete", `/shortenUrl/${shortUrl}`, token).expect(200);

            const pasteId: string = (
                await withKey("post", "/paste", token).send({ paste: "key paste" }).expect(201)
            ).body.paste._id;
            expect(
                (await withKey("get", `/pastes/${user.username}`, token).expect(200)).body.pastes
                    .length
            ).toBe(1);
            await withKey("patch", `/paste/${pasteId}`, token).send({ language: "go" }).expect(200);
            await withKey("delete", `/paste/${pasteId}`, token).expect(200);

            const uploadId: string = (
                await withKey("post", "/upload", token)
                    .attach("file", testPng, "key.png")
                    .expect(201)
            ).body.upload.id;
            await withKey("get", "/uploads/usage", token).expect(200);
            expect((await withKey("get", "/uploads", token).expect(200)).body.uploads.length).toBe(
                1
            );
            await withKey("get", `/upload/${uploadId}`, token).expect(200);
            await withKey("patch", `/upload/${uploadId}`, token)
                .send({ originalFileName: "renamed.png" })
                .expect(200);
            await withKey("delete", `/upload/${uploadId}`, token).expect(200);
        });

        it("should rename only the key's own account", async (): Promise<void> => {
            const { token } = await seedKey(owner.id, ["account:write"]);

            await withKey("patch", `/users/${other.id}`, token)
                .send({ username: `ak${newObjectId().slice(-6)}` })
                .expect(403);
            await withKey("patch", `/users/${owner.id}`, token)
                .send({ username: owner.username })
                .expect(200);
        });

        it("should refuse another user's short URLs, pastes and uploads", async (): Promise<void> => {
            const { token } = await seedKey(owner.id, [
                "shortUrls:write",
                "pastes:write",
                "uploads:read",
                "uploads:write"
            ]);
            const shortUrl: string = (
                await request(TestData.apiURL)
                    .post("/shortenUrl")
                    .set("Cookie", other.cookie)
                    .send({ url: `https://${TestData.runId}-${newObjectId()}.vb2007.test/` })
                    .expect(201)
            ).body.data.shortenedUrl;
            const pasteId: string = (
                await request(TestData.apiURL)
                    .post("/paste")
                    .set("Cookie", other.cookie)
                    .send({ paste: "not yours" })
                    .expect(201)
            ).body.paste._id;
            const uploadId: string = (
                await request(TestData.apiURL)
                    .post("/upload")
                    .set("Cookie", other.cookie)
                    .attach("file", testPng, "other.png")
                    .expect(201)
            ).body.upload.id;

            await withKey("delete", `/shortenUrl/${shortUrl}`, token).expect(403);
            await withKey("patch", `/paste/${pasteId}`, token).send({ language: "go" }).expect(403);
            await withKey("delete", `/paste/${pasteId}`, token).expect(403);
            await withKey("get", `/upload/${uploadId}`, token).expect(403);
            await withKey("delete", `/upload/${uploadId}`, token).expect(403);
            await withKey("delete", `/upload/${newObjectId()}`, token).expect(404);
        });
    });

    describe("superuser keys", (): void => {
        let readKey: SeededKey;
        let writeKey: SeededKey;

        beforeAll(async (): Promise<void> => {
            readKey = await seedKey(TestData.superuser.id, [
                "pastes:write",
                "uploads:write",
                "shortUrls:write",
                "admin:read"
            ]);
            writeKey = await seedKey(TestData.superuser.id, ["pastes:write", "admin:write"]);
        });

        it.each(adminRoutes)(
            "should answer %s %s by the admin:read and admin:write scopes",
            async (method: Method, path: string): Promise<void> => {
                const [allowed, refused, scope] =
                    method === "get"
                        ? [readKey, writeKey, "admin:read"]
                        : [writeKey, readKey, "admin:write"];

                expectScopeMissing(await withKey(method, pathOf(path), refused.token), scope);
                expectPastAuthentication(await withKey(method, pathOf(path), allowed.token));
            }
        );

        it("should not let a key without admin:write act on other users' content", async (): Promise<void> => {
            const pasteId: string = (
                await request(TestData.apiURL)
                    .post("/paste")
                    .set("Cookie", other.cookie)
                    .send({ paste: "superuser target" })
                    .expect(201)
            ).body.paste._id;
            const shortUrl: string = (
                await request(TestData.apiURL)
                    .post("/shortenUrl")
                    .set("Cookie", other.cookie)
                    .send({ url: `https://${TestData.runId}-${newObjectId()}.vb2007.test/` })
                    .expect(201)
            ).body.data.shortenedUrl;

            const uploadId: string = (
                await request(TestData.apiURL)
                    .post("/upload")
                    .set("Cookie", other.cookie)
                    .attach("file", testPng, "superuser-target.png")
                    .expect(201)
            ).body.upload.id;

            await withKey("delete", `/paste/${pasteId}`, readKey.token).expect(403);
            await withKey("delete", `/shortenUrl/${shortUrl}`, readKey.token).expect(403);
            await withKey("delete", `/upload/${uploadId}`, readKey.token).expect(403);
            await withKey("delete", `/paste/${pasteId}`, writeKey.token).expect(200);
        });

        it("should keep the lockouts when an admin:write key tries to clear them", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            await request(TestData.apiURL)
                .post("/auth/login")
                .set("X-Forwarded-For", clientIp)
                .send({ email: other.email, password: "wrong-password" })
                .expect(403);

            const refused: supertest.Response = await withKey(
                "delete",
                "/admin/rate-limits",
                writeKey.token,
                clientIp
            )
                .send({ email: other.email })
                .expect(403);
            expect(refused.body).toEqual({ error: Responses.ApiKeys.apiKeyNotAccepted });

            const cleared: supertest.Response = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ email: other.email })
                .expect(200);
            expect(cleared.body.cleared).toEqual(
                expect.arrayContaining(["loginPerAccount", "loginPerEmail"])
            );
        });

        it("should refuse an admin:write key logging out the superuser's own account", async (): Promise<void> => {
            for (const id of [TestData.superuser.id, TestData.superuser.id.toUpperCase()]) {
                const response: supertest.Response = await withKey(
                    "post",
                    `/admin/users/${id}/logout`,
                    writeKey.token
                ).expect(409);
                expect(response.body).toEqual({ error: Responses.Admin.superuserLogout });
            }

            await request(TestData.apiURL)
                .get("/admin/stats")
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);
        });

        it("should let an admin:write key log out another user", async (): Promise<void> => {
            const target: TestUser = await createTestUser("akl");

            const response: supertest.Response = await withKey(
                "post",
                `/admin/users/${target.id}/logout`,
                writeKey.token
            ).expect(200);
            expect(response.body.message).toBe(Responses.Admin.userLoggedOutSuccess);
            await request(TestData.apiURL).get("/user").set("Cookie", target.cookie).expect(403);
        });

        it("should keep admin scopes from working on a normal user's key", async (): Promise<void> => {
            const { token } = await seedKey(owner.id, ["admin:read", "admin:write"]);

            const response: supertest.Response = await withKey("get", "/admin/stats", token);

            expect(response.status).toBe(403);
            expect(response.body).toEqual({ error: Responses.notAuthorized });
        });
    });

    describe("failed key limit", (): void => {
        it("should lock out a client after too many rejected keys, not counting a valid key's 404s and 403s", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();
            const { token } = await seedKey(owner.id, ["pastes:write"]);

            for (let attempt: number = 1; attempt < FAILED_ATTEMPTS_PER_IP; attempt++) {
                expectRejectedKey(await withAuthorization("get", "/user", "Bearer x", clientIp));
            }

            for (let attempt: number = 0; attempt < 3; attempt++) {
                await withKey("delete", `/paste/${newObjectId()}`, token, clientIp).expect(404);
                expectScopeMissing(await withKey("get", "/user", token, clientIp), "account:read");
            }

            expectRejectedKey(await withKey("get", "/user", createApiKeyToken(), clientIp));

            const limited: supertest.Response = await withKey(
                "delete",
                `/paste/${newObjectId()}`,
                token,
                clientIp
            ).expect(429);
            expect(limited.body.error).toBe(Responses.tooManyFailedAttempts);

            await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", owner.cookie)
                .set("X-Forwarded-For", clientIp)
                .expect(200);
            await withKey("get", "/user/api-keys", token, clientIp).expect(403);

            const cleared: supertest.Response = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ ip: clientIp })
                .expect(200);
            expect(cleared.body.cleared).toContain("apiKeyChecksPerIp");

            await withKey("delete", `/paste/${newObjectId()}`, token, clientIp).expect(404);
        }, 60000);
    });

    describe("last use", (): void => {
        it("should store when a key was last used, at most once a minute", async (): Promise<void> => {
            const { id, token } = await seedKey(owner.id, ["account:read"]);
            const before: Date = new Date();

            await withKey("get", "/user", token).expect(200);
            const firstUse: Date = await waitForLastUse(owner.id, id, before);

            await withKey("get", "/user", token).expect(200);
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(await lastUsedAtOf(owner.id, id)).toEqual(firstUse);
        });

        it("should store a new last use once the last one is over a minute old", async (): Promise<void> => {
            const longAgo: Date = new Date(Date.now() - 2 * minuteMs);
            const { id, token } = await seedKey(owner.id, ["account:read"], {
                lastUsedAt: longAgo
            });

            await withKey("get", "/user", token).expect(200);

            expect((await waitForLastUse(owner.id, id, longAgo)).getTime()).toBeGreaterThan(
                Date.now() - minuteMs
            );
        });
    });

    describe("CORS", (): void => {
        it("should allow the Authorization header for configured origins only", async (): Promise<void> => {
            const [origin] = parseCorsOrigins(process.env.CORS_ORIGIN_URLS);
            const preflight = (requestOrigin: string): supertest.Test =>
                request(TestData.apiURL)
                    .options("/user")
                    .set("Origin", requestOrigin)
                    .set("Access-Control-Request-Method", "GET")
                    .set("Access-Control-Request-Headers", "authorization");

            const allowed: supertest.Response = await preflight(origin).expect(204);
            expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
            expect(allowed.headers["access-control-allow-headers"]).toMatch(/authorization/i);

            const refused: supertest.Response = await preflight("https://evil.vb2007.test");
            expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
        });
    });
});
