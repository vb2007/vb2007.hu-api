import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    OAUTH_CLIENT_CHECKS_PER_IP,
    OAUTH_CLIENT_REQUESTS_PER_CLIENT,
    OAUTH_STATUS_ENTRIES_MAX
} from "../constants/limits";
import { setUserSuspension } from "../database/users";
import {
    OauthClient,
    clientSecretMatches,
    hashClientSecret,
    parseOauthClients
} from "../helpers/oauthClients";
import { newObjectId } from "../helpers/prisma";
import { createApiKeyToken } from "../helpers/apiKeys";
import { TestUser, createTestUser, isolatedClientIp, randomHex } from "./helpers/testUsers";
import { basicAuthorization, describeWithOauthClients } from "./helpers/oauthTests";

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

const expectRejectedClient = (response: supertest.Response): void => {
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Basic realm="vb2007.hu"');
    expect(response.body).toEqual({ error: Responses.OAuth.invalidClient });
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
                sent <= OAUTH_CLIENT_REQUESTS_PER_CLIENT && !limited;
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
