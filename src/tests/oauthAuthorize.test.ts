import crypto from "crypto";
import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    OAUTH_AUTHORIZATIONS_PER_ACCOUNT,
    OAUTH_PARAM_MAX_LENGTH,
    OAUTH_TOKEN_FORM_MAX_BYTES
} from "../constants/limits";
import { db } from "../prisma/db";
import { setUserSuspension } from "../database/users";
import { hashSessionToken } from "../helpers";
import { createApiKeyToken } from "../helpers/apiKeys";
import { withQuery } from "../helpers/oauthAuthorize";
import {
    TestUser,
    createTestUser,
    currentUserId,
    isolatedClientIp,
    randomHex
} from "./helpers/testUsers";
import { basicAuthorization, describeWithOauthClients } from "./helpers/oauthTests";

const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";
const redirectUri: string = "http://localhost:5173/login/callback";

const pkcePair = (verifier: string = crypto.randomBytes(32).toString("base64url")) => ({
    verifier,
    challenge: crypto.createHash("sha256").update(verifier).digest("base64url")
});

const authorizeParams = (challenge: string, overrides: Record<string, unknown> = {}) => ({
    response_type: "code",
    client_id: "ci-app",
    redirect_uri: redirectUri,
    state: `state-${randomHex(4)}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: `nonce-${randomHex(4)}`,
    ...overrides
});

const startRequest = (query: Record<string, unknown> | string): supertest.Test =>
    request(TestData.apiURL)
        .get("/oauth/authorize")
        .query(query as Record<string, string>);

const authorizeRequest = (cookie: string, body: Record<string, unknown>): supertest.Test =>
    request(TestData.apiURL).post("/oauth/authorize").set("Cookie", cookie).send(body);

const tokenRequest = (
    body: Record<string, string>,
    authorization: string = basicAuthorization("ci-app")
): supertest.Test =>
    request(TestData.apiURL)
        .post("/oauth/token")
        .set("X-Forwarded-For", isolatedClientIp())
        .set("Authorization", authorization)
        .type("form")
        .send(body);

const codeOf = (redirectTo: string): string => new URL(redirectTo).searchParams.get("code");

const issueCode = async (cookie: string, challenge: string): Promise<string> => {
    const response: supertest.Response = await authorizeRequest(cookie, {
        ...authorizeParams(challenge),
        approve: true
    }).expect(200);

    return codeOf(response.body.redirectTo);
};

const exchange = (code: string, verifier: string, overrides: Record<string, string> = {}) => ({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    ...overrides
});

const expectTokenError = (
    response: supertest.Response,
    error: string,
    description: string
): void => {
    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ error, error_description: description });
};

describe("OAuth redirect building", (): void => {
    it("should append to a URI with or without a query", (): void => {
        expect(withQuery("https://a.test/cb", { code: "c d", state: "s&t" })).toBe(
            "https://a.test/cb?code=c+d&state=s%26t"
        );
        expect(withQuery("https://a.test/cb?app=x%20y", { code: "c" })).toBe(
            "https://a.test/cb?app=x%20y&code=c"
        );
    });
});

describeWithOauthClients("OAuth authorization code flow", (): void => {
    let user: TestUser;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("oa");
    });

    describe("GET /oauth/clients/:clientId", (): void => {
        it("should answer a client's id and name", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/oauth/clients/ci-app")
                .expect(200);

            expect(response.body).toEqual({ id: "ci-app", name: "ci-app" });
        });

        it("should answer 404 for a client without redirect URIs", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/oauth/clients/ci-other")
                .expect(404);

            expect(response.body).toEqual({ error: Responses.OAuth.clientNotFound });
        });

        it("should answer 404 for an unknown client", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(`/oauth/clients/unknown-${randomHex(4)}`)
                .expect(404);

            expect(response.body).toEqual({ error: Responses.OAuth.clientNotFound });
        });
    });

    describe("GET /oauth/authorize", (): void => {
        const { challenge } = pkcePair();

        it("should hand a valid request to the site's authorize page", async (): Promise<void> => {
            const params = authorizeParams(challenge);
            const response: supertest.Response = await startRequest({
                ...params,
                extra: "dropped"
            }).expect(302);

            expect(response.headers.location).toBe(
                `${baseSiteUrl}/authorize?${new URLSearchParams(params)}`
            );
        });

        it.each([
            ["an unknown client", { client_id: `unknown-${randomHex(4)}` }, "invalid_client"],
            ["no client", { client_id: undefined }, "invalid_client"],
            [
                "a redirect URI not on the list",
                { redirect_uri: "https://evil.test/cb" },
                "invalid_redirect_uri"
            ],
            [
                "a redirect URI with a trailing slash",
                { redirect_uri: `${redirectUri}/` },
                "invalid_redirect_uri"
            ],
            ["no redirect URI", { redirect_uri: undefined }, "invalid_redirect_uri"]
        ])(
            "should send %s to the site's page, never to the client",
            async (_, overrides: Record<string, unknown>, error: string): Promise<void> => {
                const response: supertest.Response = await startRequest(
                    authorizeParams(challenge, overrides)
                ).expect(302);

                expect(response.headers.location).toBe(`${baseSiteUrl}/authorize?error=${error}`);
            }
        );

        it("should refuse a repeated client_id", async (): Promise<void> => {
            const query: string = `${new URLSearchParams(authorizeParams(challenge))}&client_id=ci-app`;
            const response: supertest.Response = await startRequest(query).expect(302);

            expect(response.headers.location).toBe(`${baseSiteUrl}/authorize?error=invalid_client`);
        });

        it.each([
            ["another response type", { response_type: "token" }, "unsupported_response_type"],
            ["no response type", { response_type: undefined }, "invalid_request"],
            ["the plain PKCE method", { code_challenge_method: "plain" }, "invalid_request"],
            ["no PKCE method", { code_challenge_method: undefined }, "invalid_request"],
            ["no code challenge", { code_challenge: undefined }, "invalid_request"],
            ["a too short code challenge", { code_challenge: "a".repeat(42) }, "invalid_request"],
            ["a too long code challenge", { code_challenge: "a".repeat(44) }, "invalid_request"],
            [
                "a code challenge with padding",
                { code_challenge: `${"a".repeat(42)}=` },
                "invalid_request"
            ],
            ["no nonce", { nonce: undefined }, "invalid_request"],
            [
                "a too long nonce",
                { nonce: "n".repeat(OAUTH_PARAM_MAX_LENGTH + 1) },
                "invalid_request"
            ]
        ])(
            "should send %s back to the client with the state",
            async (_, overrides: Record<string, unknown>, error: string): Promise<void> => {
                const params = authorizeParams(challenge, overrides);
                const response: supertest.Response = await startRequest(params).expect(302);

                expect(response.headers.location).toBe(
                    `${redirectUri}?${new URLSearchParams({ error, state: params.state })}`
                );
            }
        );

        it.each([
            ["no state", undefined],
            ["a too long state", "s".repeat(OAUTH_PARAM_MAX_LENGTH + 1)]
        ])(
            "should send %s back to the client without it",
            async (_, state: string | undefined): Promise<void> => {
                const response: supertest.Response = await startRequest(
                    authorizeParams(challenge, { state })
                ).expect(302);

                expect(response.headers.location).toBe(`${redirectUri}?error=invalid_request`);
            }
        );
    });

    describe("POST /oauth/authorize", (): void => {
        const { challenge } = pkcePair();

        it("should need a session", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/oauth/authorize")
                .send({ ...authorizeParams(challenge), approve: true })
                .expect(403);

            expect(response.body).toEqual({ error: Responses.notLoggedIn });
        });

        it("should refuse an API key", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/oauth/authorize")
                .set("Authorization", `Bearer ${createApiKeyToken()}`)
                .send({ ...authorizeParams(challenge), approve: true })
                .expect(403);

            expect(response.body).toEqual({ error: Responses.ApiKeys.apiKeyNotAccepted });
        });

        it.each([
            ["an unknown client", { client_id: "nobody" }, Responses.OAuth.unknownClient],
            [
                "a redirect URI not on the list",
                { redirect_uri: "https://evil.test/cb" },
                Responses.OAuth.redirectUriNotAllowed
            ],
            ["no approve", { approve: undefined }, Responses.OAuth.invalidAuthorizeRequest],
            ["approve as a string", { approve: "true" }, Responses.OAuth.invalidAuthorizeRequest],
            [
                "another response type",
                { response_type: "token" },
                Responses.OAuth.invalidAuthorizeRequest
            ],
            [
                "the plain PKCE method",
                { code_challenge_method: "plain" },
                Responses.OAuth.invalidAuthorizeRequest
            ],
            [
                "a state that isn't a string",
                { state: ["a"] },
                Responses.OAuth.invalidAuthorizeRequest
            ],
            ["no nonce", { nonce: undefined }, Responses.OAuth.invalidAuthorizeRequest]
        ])(
            "should refuse %s",
            async (_, overrides: Record<string, unknown>, error: string): Promise<void> => {
                const response: supertest.Response = await authorizeRequest(user.cookie, {
                    ...authorizeParams(challenge),
                    approve: true,
                    ...overrides
                }).expect(400);

                expect(response.body).toEqual({ error });
            }
        );

        it("should refuse a foreign origin", async (): Promise<void> => {
            const response: supertest.Response = await authorizeRequest(user.cookie, {
                ...authorizeParams(challenge),
                approve: true
            })
                .set("Origin", "https://evil.test")
                .expect(403);

            expect(response.body).toEqual({ error: Responses.foreignOrigin });
        });

        it("should send a denial back with the state and no code", async (): Promise<void> => {
            const params = authorizeParams(challenge);
            const response: supertest.Response = await authorizeRequest(user.cookie, {
                ...params,
                approve: false
            }).expect(200);

            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["set-cookie"]).toBeUndefined();
            expect(response.body).toEqual({
                redirectTo: `${redirectUri}?${new URLSearchParams({
                    error: "access_denied",
                    state: params.state
                })}`
            });
        });

        it("should issue a code for the client's redirect URI with the state", async (): Promise<void> => {
            const params = authorizeParams(challenge);
            const response: supertest.Response = await authorizeRequest(user.cookie, {
                ...params,
                approve: true
            }).expect(200);

            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["set-cookie"]).toBeUndefined();

            const redirectTo: URL = new URL(response.body.redirectTo);
            const code: string = redirectTo.searchParams.get("code");

            expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(redirectUri);
            expect([...redirectTo.searchParams.keys()]).toEqual(["code", "state"]);
            expect(redirectTo.searchParams.get("state")).toBe(params.state);
            expect(code).toMatch(/^[\w-]{43}$/);
            expect(
                await db.orm.oauthcodes.where({ id: hashSessionToken(code) }).first()
            ).toMatchObject({
                clientId: "ci-app",
                redirectUri,
                codeChallenge: challenge,
                nonce: params.nonce
            });
        });

        it("should limit each account's authorization requests", async (): Promise<void> => {
            const limitedUser: TestUser = await createTestUser("oal");
            const body = { ...authorizeParams(challenge), approve: false };

            for (let sent: number = 0; sent < OAUTH_AUTHORIZATIONS_PER_ACCOUNT; sent++) {
                await authorizeRequest(limitedUser.cookie, body).expect(200);
            }

            const limited: supertest.Response = await authorizeRequest(
                limitedUser.cookie,
                body
            ).expect(429);
            expect(limited.body.error).toBe(Responses.OAuth.tooManyAuthorizations);

            const cleared: supertest.Response = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ email: limitedUser.email })
                .expect(200);
            expect(cleared.body.cleared).toContain("authorizationsPerAccount");

            await authorizeRequest(limitedUser.cookie, body).expect(200);
        }, 60000);
    });

    describe("POST /oauth/token", (): void => {
        it("should answer the identity once for the code's verifier", async (): Promise<void> => {
            const { verifier, challenge } = pkcePair();
            const params = authorizeParams(challenge);
            const issued: supertest.Response = await authorizeRequest(user.cookie, {
                ...params,
                approve: true
            }).expect(200);
            const code: string = codeOf(issued.body.redirectTo);

            const response: supertest.Response = await tokenRequest(
                exchange(code, verifier)
            ).expect(200);

            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["set-cookie"]).toBeUndefined();
            expect(response.body).toEqual({
                sub: user.id,
                email: user.email,
                email_verified: true,
                username: user.username,
                isSuperuser: false,
                nonce: params.nonce
            });

            expectTokenError(
                await tokenRequest(exchange(code, verifier)),
                "invalid_grant",
                Responses.OAuth.invalidCode
            );
            expect(await currentUserId(user.cookie)).toBe(user.id);
        });

        it("should take a JSON body", async (): Promise<void> => {
            const { verifier, challenge } = pkcePair();
            const code: string = await issueCode(user.cookie, challenge);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/oauth/token")
                .set("Authorization", basicAuthorization("ci-app"))
                .send(exchange(code, verifier))
                .expect(200);

            expect(response.body.sub).toBe(user.id);
        });

        it.each([
            ["a wrong verifier", () => ({ code_verifier: pkcePair().verifier })],
            ["a malformed verifier", () => ({ code_verifier: "short" })],
            ["another redirect URI", () => ({ redirect_uri: `${redirectUri}/` })]
        ])(
            "should refuse %s and burn the code",
            async (_, overrides: () => Record<string, string>): Promise<void> => {
                const { verifier, challenge } = pkcePair();
                const code: string = await issueCode(user.cookie, challenge);

                expectTokenError(
                    await tokenRequest(exchange(code, verifier, overrides())),
                    "invalid_grant",
                    Responses.OAuth.codeMismatch
                );
                expectTokenError(
                    await tokenRequest(exchange(code, verifier)),
                    "invalid_grant",
                    Responses.OAuth.invalidCode
                );
            }
        );

        it("should refuse another client's code and burn it", async (): Promise<void> => {
            const { verifier, challenge } = pkcePair();
            const code: string = await issueCode(user.cookie, challenge);

            expectTokenError(
                await tokenRequest(exchange(code, verifier), basicAuthorization("ci-other")),
                "invalid_grant",
                Responses.OAuth.invalidCode
            );
            expectTokenError(
                await tokenRequest(exchange(code, verifier)),
                "invalid_grant",
                Responses.OAuth.invalidCode
            );
        });

        it("should refuse an expired code", async (): Promise<void> => {
            const { verifier, challenge } = pkcePair();
            const code: string = await issueCode(user.cookie, challenge);

            await db.orm.oauthcodes
                .where({ id: hashSessionToken(code) })
                .update({ expiresAt: new Date(Date.now() - 1000) });

            expectTokenError(
                await tokenRequest(exchange(code, verifier)),
                "invalid_grant",
                Responses.OAuth.invalidCode
            );
        });

        it("should refuse a code whose account was deleted", async (): Promise<void> => {
            const deleted: TestUser = await createTestUser("oad");
            const { verifier, challenge } = pkcePair();
            const code: string = await issueCode(deleted.cookie, challenge);

            await request(TestData.apiURL)
                .delete("/user")
                .set("Cookie", deleted.cookie)
                .send({ password: deleted.password })
                .expect(200);

            expectTokenError(
                await tokenRequest(exchange(code, verifier)),
                "invalid_grant",
                Responses.OAuth.accountUnavailable
            );
        });

        it("should refuse a code whose account was suspended", async (): Promise<void> => {
            const suspended: TestUser = await createTestUser("oas");
            const { verifier, challenge } = pkcePair();
            const code: string = await issueCode(suspended.cookie, challenge);

            await setUserSuspension(suspended.id, true);

            expectTokenError(
                await tokenRequest(exchange(code, verifier)),
                "invalid_grant",
                Responses.OAuth.accountUnavailable
            );
        });

        it.each([
            [
                "another grant type",
                { grant_type: "client_credentials" },
                "unsupported_grant_type",
                Responses.OAuth.unsupportedGrantType
            ],
            [
                "no grant type",
                { grant_type: undefined },
                "invalid_request",
                Responses.OAuth.invalidTokenRequest
            ],
            [
                "no code",
                { code: undefined },
                "invalid_request",
                Responses.OAuth.invalidTokenRequest
            ],
            [
                "no redirect URI",
                { redirect_uri: undefined },
                "invalid_request",
                Responses.OAuth.invalidTokenRequest
            ],
            [
                "no verifier",
                { code_verifier: undefined },
                "invalid_request",
                Responses.OAuth.invalidTokenRequest
            ],
            ["an unknown code", {}, "invalid_grant", Responses.OAuth.invalidCode]
        ])(
            "should refuse %s",
            async (
                _,
                overrides: Record<string, string>,
                error: string,
                description: string
            ): Promise<void> => {
                expectTokenError(
                    await tokenRequest(
                        JSON.parse(
                            JSON.stringify(exchange(randomHex(16), pkcePair().verifier, overrides))
                        )
                    ),
                    error,
                    description
                );
            }
        );

        it("should refuse wrong client credentials", async (): Promise<void> => {
            const response: supertest.Response = await tokenRequest(
                exchange(randomHex(16), pkcePair().verifier),
                basicAuthorization("ci-app", "wrong")
            ).expect(401);

            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.body).toEqual({
                error: "invalid_client",
                error_description: Responses.OAuth.invalidClient
            });
        });

        it("should refuse a too large form", async (): Promise<void> => {
            const response: supertest.Response = await tokenRequest({
                ...exchange(randomHex(16), pkcePair().verifier),
                padding: "x".repeat(OAUTH_TOKEN_FORM_MAX_BYTES)
            }).expect(413);

            expect(response.body).toEqual({ error: Responses.requestTooLarge });
        });
    });
});
