import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    OAUTH_CLIENT_CHECKS_PER_IP,
    ACCOUNT_STATUS_REQUESTS_PER_CLIENT,
    OAUTH_STATUS_ENTRIES_MAX,
    OAUTH_INACTIVE_INTROSPECTIONS_PER_CLIENT
} from "../constants/limits";
import { setUserSuspension } from "../database/users";
import {
    OauthClient,
    clientSecretMatches,
    basicCredentialsOf,
    hashClientSecret,
    parseOauthClients
} from "../helpers/oauthClients";
import { newObjectId } from "../helpers/prisma";
import { createApiKeyToken } from "../helpers/apiKeys";
import { TestUser, createTestUser, isolatedClientIp, randomHex } from "./helpers/testUsers";
import { basicAuthorization, describeWithOauthClients } from "./helpers/oauthTests";
import { seedKey, waitForLastUse } from "./helpers/apiKeys";

const validClient = {
    id: "spotdl",
    name: "spotdl-web",
    secretHash: hashClientSecret("secret"),
    redirectUris: ["https://spotdl.vb2007.hu/login/callback"],
    scopes: ["submit"],
    accountStatus: true
};

const clientsJson = (...clients: unknown[]): string => JSON.stringify(clients);

const statusRequest = (
    body: unknown,
    authorization: string | null = basicAuthorization("ci-app"),
    clientIp: string = isolatedClientIp()
): supertest.Test => {
    const test: supertest.Test = request(TestData.apiURL)
        .post("/oauth/accounts/status")
        .set("X-Forwarded-For", clientIp);

    return (authorization === null ? test : test.set("Authorization", authorization)).send(
        body as object
    );
};

const introspect = (
    body: unknown,
    authorization: string | null = basicAuthorization("ci-app")
): supertest.Test => {
    const test: supertest.Test = request(TestData.apiURL)
        .post("/oauth/introspect")
        .set("X-Forwarded-For", isolatedClientIp());

    return (authorization === null ? test : test.set("Authorization", authorization)).send(
        body as object
    );
};

const expectInactive = async (token: string, client: string = "ci-app"): Promise<void> => {
    const response: supertest.Response = await introspect(
        { token },
        basicAuthorization(client)
    ).expect(200);

    expect(response.body).toEqual({ active: false });
};

const expectRejectedClient = (response: supertest.Response): void => {
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Basic realm="vb2007.hu"');
    expect(response.body).toEqual({
        error: "invalid_client",
        error_description: Responses.OAuth.invalidClient
    });
};

describe("OAuth client registry", (): void => {
    it("should have no clients without OAUTH_CLIENTS", (): void => {
        expect(parseOauthClients(undefined)).toEqual([]);
        expect(parseOauthClients("")).toEqual([]);
    });

    it("should parse valid clients", (): void => {
        const { accountStatus, ...withoutFlag } = validClient;
        const other: OauthClient = {
            ...withoutFlag,
            accountStatus: false,
            id: "spotdl-dev",
            redirectUris: [
                "http://localhost:5173/login/callback",
                "http://127.0.0.1:5174/login/callback",
                "http://[::1]:5175/login/callback"
            ],
            scopes: []
        };

        expect(
            parseOauthClients(clientsJson(validClient, { ...other, accountStatus: undefined }))
        ).toEqual([validClient, other]);
        expect(accountStatus).toBe(true);
    });

    it.each([
        ["a JSON object", JSON.stringify(validClient)],
        ["an entry that isn't an object", clientsJson("spotdl")],
        ["an id with a colon", clientsJson({ ...validClient, id: "spotdl:submit" })],
        ["an id with capitals", clientsJson({ ...validClient, id: "Spotdl" })],
        ["a missing id", clientsJson({ ...validClient, id: undefined })],
        ["an API key scope prefix as id", clientsJson({ ...validClient, id: "admin" })],
        [
            "a camelCase API key scope prefix as id",
            clientsJson({ ...validClient, id: "shorturls" })
        ],
        ["a blank name", clientsJson({ ...validClient, name: " " })],
        ["a secret hash that isn't SHA-256 hex", clientsJson({ ...validClient, secretHash: "x" })],
        [
            "a relative redirect URI",
            clientsJson({ ...validClient, redirectUris: ["/login/callback"] })
        ],
        [
            "a javascript: redirect URI",
            clientsJson({ ...validClient, redirectUris: ["javascript:alert(1)"] })
        ],
        [
            "a data: redirect URI",
            clientsJson({ ...validClient, redirectUris: ["data:text/html,<p>hi</p>"] })
        ],
        [
            "a custom scheme redirect URI",
            clientsJson({ ...validClient, redirectUris: ["spotdl://login/callback"] })
        ],
        [
            "a plain http redirect URI on a public host",
            clientsJson({
                ...validClient,
                redirectUris: ["http://spotdl.vb2007.hu/login/callback"]
            })
        ],
        [
            "a redirect URI with a fragment",
            clientsJson({ ...validClient, redirectUris: ["https://a.example/cb#frag"] })
        ],
        [
            "a redirect URI with an empty fragment",
            clientsJson({ ...validClient, redirectUris: ["https://a.example/cb#"] })
        ],
        ["redirect URIs that aren't a list", clientsJson({ ...validClient, redirectUris: "x" })],
        ["a scope that isn't a string", clientsJson({ ...validClient, scopes: [1] })],
        ["the same scope twice", clientsJson({ ...validClient, scopes: ["submit", "submit"] })],
        [
            "an accountStatus that isn't a boolean",
            clientsJson({ ...validClient, accountStatus: "yes" })
        ],
        ["a plaintext secret", clientsJson({ ...validClient, secret: "secret" })],
        ["an unknown field", clientsJson({ ...validClient, extra: true })],
        ["a missing scope list", clientsJson({ ...validClient, scopes: undefined })],
        ["the same id twice", clientsJson(validClient, { ...validClient, name: "other" })]
    ])("should refuse %s", (_, value: string): void => {
        expect(() => parseOauthClients(value)).toThrow();
    });

    it("should refuse invalid JSON without echoing the value", (): void => {
        const value: string = `[{"secretHash":"${validClient.secretHash}"`;

        expect(() => parseOauthClients(value)).toThrow(
            new Error("OAUTH_CLIENTS must be valid JSON")
        );
    });

    it.each([
        ["Basic", "spotdl:secret", { id: "spotdl", secret: "secret" }],
        ["basic", "spotdl:secret", { id: "spotdl", secret: "secret" }],
        ["BASIC", "spotdl:a:b:", { id: "spotdl", secret: "a:b:" }],
        ["Basic", "spotdl:", { id: "spotdl", secret: "" }],
        ["Basic", ":secret", null],
        ["Basic", "spotdl", null],
        ["Bearer", "spotdl:secret", null]
    ])(
        "should read %s %s as Basic credentials",
        (scheme: string, credentials: string, expected: object | null): void => {
            expect(
                basicCredentialsOf(`${scheme} ${Buffer.from(credentials).toString("base64")}`)
            ).toEqual(expected);
        }
    );

    it("should match only the client's own secret", (): void => {
        const [client]: OauthClient[] = parseOauthClients(clientsJson(validClient));

        expect(clientSecretMatches(client, "secret")).toBe(true);
        expect(clientSecretMatches(client, "secreT")).toBe(false);
        expect(clientSecretMatches(client, "")).toBe(false);
    });
});

describeWithOauthClients("POST /oauth/accounts/status", (): void => {
    let user: TestUser;
    let suspended: TestUser;
    let suspendedAt: string;

    beforeAll(async (): Promise<void> => {
        [user, suspended] = await Promise.all([createTestUser("oau"), createTestUser("oas")]);
        await setUserSuspension(suspended.id, true);

        const response: supertest.Response = await statusRequest({
            subs: [suspended.id]
        }).expect(200);
        suspendedAt = response.body.accounts[0].suspendedAt;
    });

    const existing = (account: TestUser, isSuperuser: boolean = false) => ({
        exists: true,
        id: account.id,
        username: account.username,
        isSuperuser,
        suspendedAt: null as string | null
    });

    describe("client authentication", (): void => {
        it.each([
            ["no credentials", null],
            ["an API key", `Bearer ${createApiKeyToken()}`],
            ["credentials that aren't base64", "Basic !!!"],
            ["credentials without a secret", `Basic ${Buffer.from("ci-app").toString("base64")}`],
            ["an unknown client", basicAuthorization(`unknown-${randomHex(4)}`)],
            ["a wrong secret", basicAuthorization("ci-app", "wrong")],
            ["an empty secret", basicAuthorization("ci-app", "")]
        ])("should refuse %s", async (_, authorization: string | null): Promise<void> => {
            expectRejectedClient(await statusRequest({ emails: [user.email] }, authorization));
        });

        it("should take a lowercase basic scheme", async (): Promise<void> => {
            await statusRequest(
                { emails: [user.email] },
                basicAuthorization("ci-app").replace("Basic", "basic")
            ).expect(200);
        });

        it("should refuse a client registered without accountStatus", async (): Promise<void> => {
            const response: supertest.Response = await statusRequest(
                { emails: [user.email] },
                basicAuthorization("ci-other")
            ).expect(403);

            expect(response.body).toEqual({ error: Responses.OAuth.accountStatusNotAllowed });
        });

        it("should lock out an IP's wrong credentials after too many, not its valid ones", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            for (let attempt: number = 0; attempt < OAUTH_CLIENT_CHECKS_PER_IP; attempt++) {
                expectRejectedClient(
                    await statusRequest(
                        { emails: [user.email] },
                        basicAuthorization("ci-app", "wrong"),
                        clientIp
                    )
                );
            }

            const limited: supertest.Response = await statusRequest(
                { emails: [user.email] },
                basicAuthorization(`unknown-${randomHex(4)}`),
                clientIp
            ).expect(429);
            expect(limited.body.error).toBe(Responses.tooManyFailedAttempts);

            await statusRequest({ emails: [user.email] }, undefined, clientIp).expect(200);

            const cleared: supertest.Response = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ ip: clientIp })
                .expect(200);
            expect(cleared.body.cleared).toContain("clientChecksPerIp");

            expectRejectedClient(
                await statusRequest(
                    { emails: [user.email] },
                    basicAuthorization("ci-app", "wrong"),
                    clientIp
                )
            );
        }, 60000);

        it("should not count parallel valid requests from one IP", async (): Promise<void> => {
            const clientIp: string = isolatedClientIp();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: OAUTH_CLIENT_CHECKS_PER_IP * 3 }, () =>
                    statusRequest({ emails: [user.email] }, undefined, clientIp)
                )
            );

            expect(responses.map(({ status }) => status)).toEqual(responses.map((): number => 200));
        });

        it("should limit each client's requests, whatever their answer", async (): Promise<void> => {
            const limits: string = basicAuthorization("ci-limits");
            let limited: supertest.Response | undefined;

            for (
                let sent: number = 0;
                sent <= ACCOUNT_STATUS_REQUESTS_PER_CLIENT && !limited;
                sent++
            ) {
                const response: supertest.Response = await statusRequest({}, limits);

                if (response.status === 429) {
                    limited = response;
                } else {
                    expect(response.status).toBe(400);
                }
            }

            expect(limited?.body.error).toBe(Responses.OAuth.tooManyRequests);
            expect(limited?.headers["retry-after"]).toEqual(expect.any(String));

            const cleared: supertest.Response = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ clientId: "ci-limits" })
                .expect(200);
            expect(cleared.body.cleared).toContain("accountStatusPerClient");

            await statusRequest({}, limits).expect(400);

            await statusRequest({ emails: [user.email] }).expect(200);
        }, 60000);
    });

    describe("status", (): void => {
        it("should answer each e-mail address as sent, matched like logins", async (): Promise<void> => {
            const unknown: string = `nobody-${randomHex(5)}@${TestData.emailDomain}`;
            const shouted: string = ` ${user.email.toUpperCase()} `;

            const response: supertest.Response = await statusRequest({
                emails: [shouted, unknown, user.email]
            }).expect(200);

            expect(response.body).toEqual({
                accounts: [
                    { email: shouted, ...existing(user) },
                    { email: unknown, exists: false },
                    { email: user.email, ...existing(user) }
                ]
            });
        });

        it("should answer each sub, then after the e-mail addresses", async (): Promise<void> => {
            const unknown: string = newObjectId();

            const response: supertest.Response = await statusRequest({
                subs: [user.id.toUpperCase(), unknown, "not-an-id", user.id],
                emails: [suspended.email]
            }).expect(200);

            expect(response.body).toEqual({
                accounts: [
                    { email: suspended.email, ...existing(suspended), suspendedAt },
                    { sub: user.id.toUpperCase(), ...existing(user) },
                    { sub: unknown, exists: false },
                    { sub: "not-an-id", exists: false },
                    { sub: user.id, ...existing(user) }
                ]
            });
        });

        it("should show when an account was suspended", async (): Promise<void> => {
            expect(new Date(suspendedAt).toISOString()).toBe(suspendedAt);
        });

        it("should flag the superuser", async (): Promise<void> => {
            const response: supertest.Response = await statusRequest({
                subs: [TestData.superuser.id]
            }).expect(200);

            expect(response.body.accounts).toEqual([
                {
                    sub: TestData.superuser.id,
                    exists: true,
                    id: TestData.superuser.id,
                    username: expect.any(String),
                    isSuperuser: true,
                    suspendedAt: null
                }
            ]);
        });

        it(`should take ${OAUTH_STATUS_ENTRIES_MAX} entries in all`, async (): Promise<void> => {
            const half: number = OAUTH_STATUS_ENTRIES_MAX / 2;

            const response: supertest.Response = await statusRequest({
                emails: Array(half).fill(user.email),
                subs: Array(half).fill(user.id)
            }).expect(200);

            expect(response.body.accounts).toHaveLength(OAUTH_STATUS_ENTRIES_MAX);
        });

        it.each([
            ["an empty body", {}],
            ["empty lists", { emails: [], subs: [] }],
            ["an array body", [{ emails: ["a@b.c"] }]],
            ["emails that aren't a list", { emails: "a@b.c" }],
            ["an e-mail address that isn't a string", { emails: [1] }],
            ["subs that aren't a list", { subs: { 0: "x" } }],
            ["null subs", { emails: ["a@b.c"], subs: null }],
            [
                `over ${OAUTH_STATUS_ENTRIES_MAX} entries in all`,
                {
                    emails: Array(OAUTH_STATUS_ENTRIES_MAX).fill("a@b.c"),
                    subs: ["x"]
                }
            ]
        ])("should refuse %s", async (_, body: unknown): Promise<void> => {
            const response: supertest.Response = await statusRequest(body).expect(400);

            expect(response.body).toEqual({ error: Responses.OAuth.invalidStatusRequest });
        });
    });
});

describeWithOauthClients("POST /oauth/introspect", (): void => {
    let user: TestUser;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("oai");
    });

    const activeFor = (account: TestUser, scopes: string[], expiresAt: string | null = null) => ({
        active: true,
        sub: account.id,
        email: account.email,
        username: account.username,
        scopes,
        expiresAt
    });

    it("should answer a key created with the client's app scope active, with only the client's scopes", async (): Promise<void> => {
        const created: supertest.Response = await request(TestData.apiURL)
            .post("/user/api-keys")
            .set("Cookie", user.cookie)
            .set("X-Forwarded-For", isolatedClientIp())
            .send({
                name: "spotdl",
                scopes: ["ci-app:submit", "ci-other:other", "pastes:read"],
                password: user.password
            })
            .expect(201);
        const { apiKey } = created.body;
        const { token } = apiKey;
        const before: Date = new Date(Date.now() - 1);

        const response: supertest.Response = await introspect({ token }).expect(200);

        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toEqual(activeFor(user, ["ci-app:submit"], apiKey.expiresAt));
        await waitForLastUse(user.id, apiKey.id, before);

        const other: supertest.Response = await introspect(
            { token },
            basicAuthorization("ci-other")
        ).expect(200);
        expect(other.body).toEqual(activeFor(user, ["ci-other:other"], apiKey.expiresAt));
    });

    it("should answer a key only active for the client whose app scope it holds", async (): Promise<void> => {
        const { token } = await seedKey(user.id, ["ci-other:other"]);

        await expectInactive(token);
        await expectInactive(token, "ci-limits");

        const response: supertest.Response = await introspect(
            { token },
            basicAuthorization("ci-other")
        ).expect(200);
        expect(response.body).toEqual(activeFor(user, ["ci-other:other"]));
    });

    it("should answer a key without an app scope inactive", async (): Promise<void> => {
        await expectInactive((await seedKey(user.id, ["pastes:read", "account:read"])).token);
    });

    it("should answer an expired key inactive", async (): Promise<void> => {
        const { token } = await seedKey(user.id, ["ci-app:submit"], {
            expiresAt: new Date(Date.now() - 1000)
        });

        await expectInactive(token);
    });

    it("should answer a deleted or unknown key inactive", async (): Promise<void> => {
        const { id, token } = await seedKey(user.id, ["ci-app:submit"]);
        await introspect({ token }).expect(200, activeFor(user, ["ci-app:submit"]));

        await request(TestData.apiURL)
            .delete(`/user/api-keys/${id}`)
            .set("Cookie", user.cookie)
            .expect(200);

        await expectInactive(token);
        await expectInactive(createApiKeyToken());
    });

    it("should answer a suspended account's key inactive", async (): Promise<void> => {
        const suspended: TestUser = await createTestUser("ois");
        const { token } = await seedKey(suspended.id, ["ci-app:submit"]);
        await setUserSuspension(suspended.id, true);

        await expectInactive(token);
    });

    it.each([
        ["an empty token", ""],
        ["a token without the prefix", createApiKeyToken().slice(4)],
        ["a short token", createApiKeyToken().slice(0, -1)],
        ["a bearer header", `Bearer ${createApiKeyToken()}`]
    ])("should answer %s inactive", async (_, token: string): Promise<void> => {
        await expectInactive(token);
    });

    it.each([
        ["an empty body", {}],
        ["a numeric token", { token: 5 }],
        ["a token list", { token: [createApiKeyToken()] }],
        ["an array body", [createApiKeyToken()]]
    ])("should refuse %s", async (_, body: unknown): Promise<void> => {
        const response: supertest.Response = await introspect(body).expect(400);

        expect(response.body).toEqual({ error: Responses.OAuth.missingToken });
    });

    it.each([
        ["no credentials", null],
        ["an API key", `Bearer ${createApiKeyToken()}`],
        ["a wrong secret", basicAuthorization("ci-app", "wrong")],
        ["an unknown client", basicAuthorization(`unknown-${randomHex(4)}`)]
    ])("should refuse %s", async (_, authorization: string | null): Promise<void> => {
        const response: supertest.Response = await introspect(
            { token: createApiKeyToken() },
            authorization
        );

        expectRejectedClient(response);
        expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("should limit each client's inactive answers, not other clients'", async (): Promise<void> => {
        const limits: string = basicAuthorization("ci-limits");
        const batch: number = 100;
        const clearLimits = (): supertest.Test =>
            request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ clientId: "ci-limits" })
                .expect(200);

        await clearLimits();

        for (let sent: number = 0; sent < OAUTH_INACTIVE_INTROSPECTIONS_PER_CLIENT; sent += batch) {
            const responses: supertest.Response[] = await Promise.all(
                Array.from(
                    { length: Math.min(batch, OAUTH_INACTIVE_INTROSPECTIONS_PER_CLIENT - sent) },
                    () => introspect({ token: "junk" }, limits)
                )
            );

            expect(responses.map(({ status }) => status)).toEqual(responses.map((): number => 200));
        }

        const limited: supertest.Response = await introspect({ token: "junk" }, limits).expect(429);
        expect(limited.body.error).toBe(Responses.OAuth.tooManyInactiveTokens);
        expect(limited.headers["retry-after"]).toEqual(expect.any(String));

        const { token } = await seedKey(user.id, ["ci-app:submit"]);
        await introspect({ token }).expect(200, activeFor(user, ["ci-app:submit"]));

        expect((await clearLimits()).body.cleared).toContain("inactiveIntrospectionsPerClient");

        await expectInactive("junk", "ci-limits");
    }, 120000);
});
