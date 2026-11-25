import type { DocsModule } from "../openapi";
import {
    duration,
    errorResponse,
    failedAttemptsWindow,
    limitedResponse,
    objectId,
    requestTooLarge,
    serverError
} from "../components";
import { Responses } from "../../constants/responses";
import {
    OAUTH_CLIENT_CHECKS_PER_IP,
    ACCOUNT_STATUS_REQUESTS_PER_CLIENT,
    ACCOUNT_STATUS_REQUESTS_WINDOW_MS,
    OAUTH_STATUS_ENTRIES_MAX,
    OAUTH_INACTIVE_INTROSPECTIONS_PER_CLIENT
} from "../../constants/limits";

export const tags: DocsModule["tags"] = [
    {
        name: "OAuth",
        description:
            "Server-to-server routes for vb2007.hu's first-party apps. Each app is a client registered by the site's owner, and authenticates with its client id and secret as `Authorization: Basic base64(client_id:client_secret)`."
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
    "/oauth/introspect": {
        post: {
            tags: ["OAuth"],
            summary: "Check an API key",
            description: `Tells the app whether a vb2007.hu API key (\`vbk_…\`) its user gave it is live and holds one of the app's scopes, like RFC 7662 token introspection. App scopes are \`<client>:<scope>\` for the client's registered scopes (e.g. \`spotdl:submit\`), chosen by the user when creating the key. They allow no route of this API.

A key is \`active\` only when it exists, hasn't expired, its account isn't suspended, and it holds at least one of the calling client's app scopes. Anything else, a token that isn't shaped like a key included, answers \`{ "active": false }\` and nothing more. \`scopes\` lists only the calling client's app scopes the key holds, not its other scopes. An active answer updates the key's \`lastUsedAt\`, at most once a minute like on any key use; an inactive one never does, so a client can't touch keys it can't use. The route's own answers carry \`Cache-Control: no-store\` (the shared invalid JSON \`400\` and \`413\` don't). Apps may cache an answer for about a minute, so a revoked key stops working within that time.

Needs a client's credentials, never a session or API key. Rejected credentials count ${OAUTH_CLIENT_CHECKS_PER_IP} per client IP in ${failedAttemptsWindow}, after which that IP's wrong credentials answer \`429\` while valid ones still work. Inactive checks of tokens shaped like a key count ${OAUTH_INACTIVE_INTROSPECTIONS_PER_CLIENT} per client in ${failedAttemptsWindow}: inactive checks over the limit answer \`429\` until the window ends; active ones are never limited. Tokens not shaped like a key and \`400\`s aren't counted. An app should check the token's shape first and cache inactive answers too, so junk keys don't use up its budget.`,
            security: [{ clientAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["token"],
                            properties: {
                                token: { type: "string", description: "The API key to check." }
                            }
                        },
                        example: { token: `vbk_${"0".repeat(39)}x9Qk` }
                    }
                }
            },
            responses: {
                "200": {
                    description:
                        "Whether the key is active for this client, with its account and the client's scopes it holds when it is.",
                    content: {
                        "application/json": {
                            schema: {
                                oneOf: [
                                    {
                                        type: "object",
                                        required: [
                                            "active",
                                            "sub",
                                            "email",
                                            "username",
                                            "scopes",
                                            "expiresAt"
                                        ],
                                        properties: {
                                            active: { type: "boolean", const: true },
                                            sub: {
                                                ...objectId,
                                                description: "The key's account id."
                                            },
                                            email: { type: "string", format: "email" },
                                            username: { type: "string" },
                                            scopes: {
                                                type: "array",
                                                minItems: 1,
                                                items: { type: "string" },
                                                description:
                                                    "The calling client's app scopes the key holds, as `<client>:<scope>`."
                                            },
                                            expiresAt: {
                                                type: ["string", "null"],
                                                format: "date-time",
                                                description:
                                                    "When the key expires, `null` when it never does."
                                            }
                                        }
                                    },
                                    {
                                        type: "object",
                                        required: ["active"],
                                        properties: { active: { type: "boolean", const: false } },
                                        additionalProperties: false
                                    }
                                ]
                            },
                            examples: {
                                active: {
                                    value: {
                                        active: true,
                                        sub: "6745a1f2c3d4e5f601234567",
                                        email: "user@example.com",
                                        username: "someone",
                                        scopes: ["spotdl:submit"],
                                        expiresAt: "2027-02-19T10:00:00.000Z"
                                    }
                                },
                                inactive: { value: { active: false } }
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "Invalid JSON, or no `token` string in the body.",
                    Responses.invalidJson,
                    Responses.OAuth.missingToken
                ),
                "401": { $ref: "#/components/responses/InvalidClient" },
                "413": requestTooLarge,
                "429": limitedResponse(
                    `Wrong credentials after ${OAUTH_CLIENT_CHECKS_PER_IP} rejected client credentials from this IP address in ${failedAttemptsWindow}, or an inactive check after ${OAUTH_INACTIVE_INTROSPECTIONS_PER_CLIENT} inactive checks by this client in ${failedAttemptsWindow}. Active checks are never limited.`,
                    Responses.tooManyFailedAttempts,
                    Responses.OAuth.tooManyInactiveTokens
                ),
                "500": serverError
            }
        }
    }
};
