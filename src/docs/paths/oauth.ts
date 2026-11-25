import type { DocsModule } from "../openapi";
import {
    duration,
    errorResponse,
    failedAttemptsWindow,
    limitedResponse,
    objectId,
    redirectResponse,
    requestTooLarge,
    serverError,
    sessionForbiddenResponse
} from "../components";
import { Responses } from "../../constants/responses";
import {
    OAUTH_CLIENT_CHECKS_PER_IP,
    ACCOUNT_STATUS_REQUESTS_PER_CLIENT,
    ACCOUNT_STATUS_REQUESTS_WINDOW_MS,
    OAUTH_STATUS_ENTRIES_MAX,
    OAUTH_CODE_SECONDS,
    OAUTH_PARAM_MAX_LENGTH,
    OAUTH_AUTHORIZATIONS_PER_ACCOUNT,
    OAUTH_AUTHORIZATIONS_WINDOW_MS,
    FAILED_TOKEN_EXCHANGES_PER_CLIENT,
    OAUTH_TOKEN_FORM_MAX_BYTES
} from "../../constants/limits";

export const tags: DocsModule["tags"] = [
    {
        name: "OAuth",
        description:
            "Sign in with vb2007.hu for the site's first-party apps (OAuth 2.0 authorization code flow with PKCE), and server-to-server routes for them. Each app is a client registered by the site's owner, and its server authenticates with its client id and secret as `Authorization: Basic base64(client_id:client_secret)`."
    }
];

const accountEntry = (key: "email" | "sub", description: string) => ({
    type: "object",
    required: [key, "exists"],
    properties: {
        [key]: { type: "string", description },
        exists: { type: "boolean" },
        id: { ...objectId, description: "The account's id: its `sub`. Only when it exists." },
        username: { type: "string", description: "Only when it exists." },
        isSuperuser: { type: "boolean", description: "Only when it exists." },
        suspendedAt: {
            type: ["string", "null"],
            format: "date-time",
            description:
                "When the account was suspended, `null` when it isn't. Only when it exists."
        }
    }
});

const stringList = (description: string) => ({
    type: "array",
    maxItems: OAUTH_STATUS_ENTRIES_MAX,
    items: { type: "string" },
    description
});

const authorizeFields: Record<string, { description: string; [field: string]: unknown }> = {
    response_type: { type: "string", enum: ["code"], description: "Always `code`." },
    client_id: { type: "string", description: "The client's id." },
    redirect_uri: {
        type: "string",
        format: "uri",
        description: "One of the client's registered redirect URIs, matched exactly."
    },
    state: {
        type: "string",
        minLength: 1,
        maxLength: OAUTH_PARAM_MAX_LENGTH,
        description: "The client's opaque value, sent back unchanged with the code or error."
    },
    code_challenge: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{43,128}$",
        description:
            "The PKCE challenge (RFC 7636): the unpadded base64url SHA-256 of the client's `code_verifier`, 43 characters."
    },
    code_challenge_method: {
        type: "string",
        enum: ["S256"],
        description: "Always `S256`: `plain` is refused."
    },
    nonce: {
        type: "string",
        minLength: 1,
        maxLength: OAUTH_PARAM_MAX_LENGTH,
        description:
            "The client's value for this login, answered with the identity by `POST /oauth/token`."
    }
};

const authorizeExample = {
    response_type: "code",
    client_id: "spotdl",
    redirect_uri: "https://spotdl.vb2007.hu/login/callback",
    state: "af0ifjsldkj",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    nonce: "n-0S6_WzA2Mj"
};

const tokenError = (
    description: string,
    ...errors: { error: string; error_description?: string }[]
) => ({
    description,
    headers: {
        "Cache-Control": {
            description: "`no-store`, except on invalid JSON.",
            schema: { type: "string" }
        }
    },
    content: {
        "application/json": {
            schema: {
                type: "object",
                required: ["error"],
                properties: {
                    error: { type: "string" },
                    error_description: { type: "string", description: "With every OAuth error." }
                }
            },
            examples: Object.fromEntries(
                errors.map((value, index: number) => [
                    `error${index + 1}`,
                    { summary: value.error_description ?? value.error, value }
                ])
            )
        }
    }
});

const tokenFields = {
    type: "object",
    required: ["grant_type", "code", "redirect_uri", "code_verifier"],
    properties: {
        grant_type: { type: "string", enum: ["authorization_code"] },
        code: { type: "string", description: "The code from the client's redirect URI." },
        redirect_uri: {
            type: "string",
            format: "uri",
            description: "The same `redirect_uri` the authorization request sent."
        },
        code_verifier: {
            type: "string",
            pattern: "^[A-Za-z0-9._~-]{43,128}$",
            description: "The PKCE verifier the `code_challenge` was made from."
        }
    }
};

const tokenExample = {
    grant_type: "authorization_code",
    code: "SplxlOBeZQQYbYS6WxSbIA-Hk2nVx8mgaAtVwvzX2dE",
    redirect_uri: "https://spotdl.vb2007.hu/login/callback",
    code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
};

export const paths: DocsModule["paths"] = {
    "/oauth/accounts/status": {
        post: {
            tags: ["OAuth"],
            summary: "Check accounts' status",
            description: `Answers the current state of up to ${OAUTH_STATUS_ENTRIES_MAX} accounts, looked up by e-mail address or by \`sub\` (the account id), so an app can end its sessions of suspended or deleted accounts and keep usernames current. It answers one entry per requested item: the \`emails\` first, then the \`subs\`, each in the order sent, duplicates included. An entry only tells whether the account exists and, if so, its \`id\`, \`username\`, \`isSuperuser\` and \`suspendedAt\`.

Needs the credentials of a client registered with \`accountStatus: true\`, never a session or API key. Rejected credentials count ${OAUTH_CLIENT_CHECKS_PER_IP} per client IP in ${failedAttemptsWindow}, after which that IP's wrong credentials answer \`429\` while valid ones still work, so nobody can lock a client out by knowing its id, and each client can make ${ACCOUNT_STATUS_REQUESTS_PER_CLIENT} requests in ${duration(ACCOUNT_STATUS_REQUESTS_WINDOW_MS)}, whatever their answer.`,
            security: [{ clientAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            properties: {
                                emails: stringList(
                                    "E-mail addresses, matched trimmed and lowercase like logins are. One that isn't an account's answers `exists: false`."
                                ),
                                subs: stringList(
                                    "Account ids, matched ignoring case: the entry echoes the `sub` as sent, while `id` is always lowercase, so store `id`. One that isn't a 24 character hex id, or no account's, answers `exists: false`."
                                )
                            },
                            description: `At least one of \`emails\` and \`subs\`, with 1 to ${OAUTH_STATUS_ENTRIES_MAX} entries in all.`
                        },
                        example: {
                            emails: ["user@example.com", "gone@example.com"],
                            subs: ["6745a1f2c3d4e5f601234567"]
                        }
                    }
                }
            },
            responses: {
                "200": {
                    description: "One entry per requested item.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["accounts"],
                                properties: {
                                    accounts: {
                                        type: "array",
                                        items: {
                                            oneOf: [
                                                accountEntry("email", "The address as sent."),
                                                accountEntry("sub", "The id as sent.")
                                            ]
                                        }
                                    }
                                }
                            },
                            example: {
                                accounts: [
                                    {
                                        email: "user@example.com",
                                        exists: true,
                                        id: "6745a1f2c3d4e5f601234567",
                                        username: "someone",
                                        isSuperuser: false,
                                        suspendedAt: null
                                    },
                                    { email: "gone@example.com", exists: false },
                                    {
                                        sub: "6745a1f2c3d4e5f601234567",
                                        exists: true,
                                        id: "6745a1f2c3d4e5f601234567",
                                        username: "someone",
                                        isSuperuser: false,
                                        suspendedAt: null
                                    }
                                ]
                            }
                        }
                    }
                },
                "400": errorResponse(
                    `Invalid JSON, a body that isn't an object, \`emails\` or \`subs\` that isn't a list of strings, or fewer than 1 or more than ${OAUTH_STATUS_ENTRIES_MAX} entries in all.`,
                    Responses.invalidJson,
                    Responses.OAuth.invalidStatusRequest
                ),
                "401": { $ref: "#/components/responses/InvalidClient" },
                "403": errorResponse(
                    "The client isn't registered with `accountStatus: true`.",
                    Responses.OAuth.accountStatusNotAllowed
                ),
                "413": requestTooLarge,
                "429": limitedResponse(
                    `Wrong credentials after ${OAUTH_CLIENT_CHECKS_PER_IP} rejected client credentials from this IP address in ${failedAttemptsWindow}, or any request after ${ACCOUNT_STATUS_REQUESTS_PER_CLIENT} requests from this client in ${duration(ACCOUNT_STATUS_REQUESTS_WINDOW_MS)}.`,
                    Responses.tooManyFailedAttempts,
                    Responses.OAuth.tooManyRequests
                ),
                "500": serverError
            }
        }
    },
    "/oauth/clients/{clientId}": {
        get: {
            tags: ["OAuth"],
            summary: "Get a client",
            description:
                "Answers a registered client's id and display name, for the site's authorize page to show which app asks to sign in. Public.",
            security: [],
            parameters: [
                {
                    name: "clientId",
                    in: "path",
                    required: true,
                    description: "The client's id.",
                    schema: { type: "string" }
                }
            ],
            responses: {
                "200": {
                    description: "The client.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["id", "name"],
                                properties: { id: { type: "string" }, name: { type: "string" } }
                            },
                            example: { id: "spotdl", name: "spotdl-web" }
                        }
                    }
                },
                "404": errorResponse("No client has this id.", Responses.OAuth.clientNotFound),
                "500": serverError
            }
        }
    },
    "/oauth/authorize": {
        get: {
            tags: ["OAuth"],
            summary: "Start a sign-in",
            description: `Where an app sends the browser to sign a user in (the OAuth 2.0 authorization endpoint, with PKCE). A valid request redirects to the site's authorize page with the same parameters (any others dropped), where the user logs in if needed and approves or denies with \`POST /oauth/authorize\`.

An unknown \`client_id\`, or a \`redirect_uri\` that isn't exactly one of the client's, never redirects to the app: it goes to \`<site>/authorize?error=invalid_client\` or \`?error=invalid_redirect_uri\`. Any other problem redirects to the \`redirect_uri\` with \`error=unsupported_response_type\` (a \`response_type\` other than \`code\`) or \`error=invalid_request\` (anything else missing, repeated or invalid, \`plain\` PKCE included), plus the \`state\` when it is valid. Public.`,
            security: [],
            parameters: Object.entries(authorizeFields).map(
                ([name, { description, ...schema }]) => ({
                    name,
                    in: "query",
                    required: true,
                    description,
                    schema
                })
            ),
            responses: {
                "302": redirectResponse(
                    "To the site's authorize page, or back with an error.",
                    "`<site>/authorize?<the parameters>`, `<site>/authorize?error=<code>`, or `<redirect_uri>?error=<code>&state=<state>`.",
                    "https://vb2007.hu/authorize?response_type=code&client_id=spotdl&redirect_uri=https%3A%2F%2Fspotdl.vb2007.hu%2Flogin%2Fcallback&state=af0ifjsldkj&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&nonce=n-0S6_WzA2Mj"
                ),
                "500": serverError
            }
        },
        post: {
            tags: ["OAuth"],
            summary: "Approve or deny a sign-in",
            description: `The site's authorize page sends the user's answer here, with the parameters \`GET /oauth/authorize\` handed it. Everything is checked again. Denying answers the \`redirect_uri\` with \`error=access_denied\` and the \`state\`. Approving issues a one-time code, valid for ${OAUTH_CODE_SECONDS} seconds and bound to the client, the \`redirect_uri\`, the \`code_challenge\`, the \`nonce\` and the account, and answers the \`redirect_uri\` with the \`code\` and \`state\` (added to any query it already has). The page then sends the browser there. The account's session is left as it is.

Needs a session, never an API key. Each account can make ${OAUTH_AUTHORIZATIONS_PER_ACCOUNT} requests in ${duration(OAUTH_AUTHORIZATIONS_WINDOW_MS)}, whatever their answer.`,
            security: [{ session: [] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: [...Object.keys(authorizeFields), "approve"],
                            properties: {
                                ...authorizeFields,
                                approve: {
                                    type: "boolean",
                                    description: "`true` to sign in to the app, `false` to deny."
                                }
                            }
                        },
                        example: { ...authorizeExample, approve: true }
                    }
                }
            },
            responses: {
                "200": {
                    description: "Where the page sends the browser. `Cache-Control: no-store`.",
                    headers: {
                        "Cache-Control": { description: "`no-store`.", schema: { type: "string" } }
                    },
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["redirectTo"],
                                properties: { redirectTo: { type: "string", format: "uri" } }
                            },
                            examples: {
                                approved: {
                                    value: {
                                        redirectTo:
                                            "https://spotdl.vb2007.hu/login/callback?code=SplxlOBeZQQYbYS6WxSbIA-Hk2nVx8mgaAtVwvzX2dE&state=af0ifjsldkj"
                                    }
                                },
                                denied: {
                                    value: {
                                        redirectTo:
                                            "https://spotdl.vb2007.hu/login/callback?error=access_denied&state=af0ifjsldkj"
                                    }
                                }
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "Invalid JSON, an unknown `client_id`, a `redirect_uri` that isn't exactly one of the client's, or any other parameter missing or invalid (including `approve` that isn't a boolean).",
                    Responses.invalidJson,
                    Responses.OAuth.unknownClient,
                    Responses.OAuth.redirectUriNotAllowed,
                    Responses.OAuth.invalidAuthorizeRequest
                ),
                "403": sessionForbiddenResponse(),
                "413": requestTooLarge,
                "429": limitedResponse(
                    `After ${OAUTH_AUTHORIZATIONS_PER_ACCOUNT} requests from this account in ${duration(OAUTH_AUTHORIZATIONS_WINDOW_MS)}.`,
                    Responses.OAuth.tooManyAuthorizations
                ),
                "500": serverError
            }
        }
    },
    "/oauth/token": {
        post: {
            tags: ["OAuth"],
            summary: "Exchange a code for the identity",
            description: `The app's server trades the code from its redirect URI for the user's identity (the OAuth 2.0 token endpoint). The code works once: the first exchange uses it up, even one that fails. It must have been issued to this client in the last ${OAUTH_CODE_SECONDS} seconds, the \`redirect_uri\` must equal the authorization request's, the \`code_verifier\`'s SHA-256 must match the \`code_challenge\`, and the account must still exist and not be suspended. No session is created or changed, the user's own vb2007.hu session included.

Takes \`application/x-www-form-urlencoded\` as RFC 6749 asks, or JSON. Errors have the RFC 6749 §5.2 shape. Needs the client's credentials, never a session or API key. Rejected credentials count ${OAUTH_CLIENT_CHECKS_PER_IP} per client IP in ${failedAttemptsWindow}, after which that IP's wrong credentials answer \`429\`, and each client can fail ${FAILED_TOKEN_EXCHANGES_PER_CLIENT} exchanges (RFC 6749 error answers) in ${failedAttemptsWindow}, after which all its exchanges answer \`429\` until the window ends.`,
            security: [{ clientAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    "application/x-www-form-urlencoded": {
                        schema: tokenFields,
                        example: tokenExample
                    },
                    "application/json": { schema: tokenFields, example: tokenExample }
                }
            },
            responses: {
                "200": {
                    description: "The account's identity. `Cache-Control: no-store`.",
                    headers: {
                        "Cache-Control": { description: "`no-store`.", schema: { type: "string" } }
                    },
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: [
                                    "sub",
                                    "email",
                                    "email_verified",
                                    "username",
                                    "isSuperuser",
                                    "nonce"
                                ],
                                properties: {
                                    sub: { ...objectId, description: "The account's id." },
                                    email: { type: "string", format: "email" },
                                    email_verified: {
                                        type: "boolean",
                                        description:
                                            "Whether the address was verified (by a mailed code or GitHub)."
                                    },
                                    username: { type: "string" },
                                    isSuperuser: { type: "boolean" },
                                    nonce: {
                                        type: "string",
                                        description: "The authorization request's `nonce`."
                                    }
                                }
                            },
                            example: {
                                sub: "6745a1f2c3d4e5f601234567",
                                email: "user@example.com",
                                email_verified: true,
                                username: "someone",
                                isSuperuser: false,
                                nonce: "n-0S6_WzA2Mj"
                            }
                        }
                    }
                },
                "400": tokenError(
                    "A failed exchange: `unsupported_grant_type` for a `grant_type` other than `authorization_code`, `invalid_request` for a missing parameter, `invalid_grant` for a code that is unknown, expired, used, another client's, or whose `redirect_uri`, `code_verifier` or account doesn't check out. Invalid JSON answers `{ error }` like elsewhere, and isn't counted as a failed exchange.",
                    {
                        error: "unsupported_grant_type",
                        error_description: Responses.OAuth.unsupportedGrantType
                    },
                    {
                        error: "invalid_request",
                        error_description: Responses.OAuth.invalidTokenRequest
                    },
                    { error: "invalid_grant", error_description: Responses.OAuth.invalidCode },
                    { error: "invalid_grant", error_description: Responses.OAuth.codeMismatch },
                    {
                        error: "invalid_grant",
                        error_description: Responses.OAuth.accountUnavailable
                    },
                    { error: Responses.invalidJson }
                ),
                "401": { $ref: "#/components/responses/InvalidClient" },
                "413": errorResponse(
                    `A JSON body over the usual limit, or a form over ${OAUTH_TOKEN_FORM_MAX_BYTES / 1024} KiB or with over 1000 fields.`,
                    Responses.requestTooLarge,
                    "too many parameters"
                ),
                "415": errorResponse(
                    "A form in a charset other than UTF-8.",
                    'unsupported charset "ISO-8859-1"'
                ),
                "429": limitedResponse(
                    `Wrong credentials after ${OAUTH_CLIENT_CHECKS_PER_IP} rejected client credentials from this IP address in ${failedAttemptsWindow}, or any exchange after ${FAILED_TOKEN_EXCHANGES_PER_CLIENT} failed exchanges by this client in ${failedAttemptsWindow}.`,
                    Responses.tooManyFailedAttempts
                ),
                "500": serverError
            }
        }
    }
};
