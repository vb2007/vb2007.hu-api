import type { DocsModule } from "../openapi";
import {
    duration,
    errorResponse,
    limitedResponse,
    rateLimitedResponse,
    requestTooLarge,
    serverError,
    sessionForbiddenResponse
} from "../components";
import { Responses } from "../../constants/responses";
import {
    API_KEYS_MAX,
    API_KEY_EXPIRY_DEFAULT_DAYS,
    API_KEY_EXPIRY_MAX_DAYS,
    API_KEY_EXPIRY_MIN_DAYS,
    API_KEY_LAST_USE_INTERVAL_MS,
    API_KEY_NAME_MAX_LENGTH,
    API_KEY_SCOPES,
    CODE_FAILURES_WINDOW_MS,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    GITHUB_REAUTH_MINUTES,
    SECURITY_NOTICES_PER_DAY
} from "../../constants/limits";

const apiKeyExample = {
    id: "3f0c9a7e5b1d4c2a8e6f0b9d7c5a3e1f",
    name: "Deploy bot",
    hint: "x9Qk",
    scopes: ["pastes:read", "pastes:write"],
    createdAt: "2026-11-21T10:00:00.000Z",
    expiresAt: "2027-02-19T10:00:00.000Z",
    lastUsedAt: null as string | null
};

const apiKeyScope = {
    anyOf: [
        { type: "string", enum: [...API_KEY_SCOPES] },
        {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$",
            description:
                "An app scope, `<client>:<scope>` for a scope of a registered OAuth client (e.g. `spotdl:submit`). It allows no route of this API: only that client's `POST /oauth/introspect` reports it."
        }
    ]
};

const idParameter = {
    name: "id",
    in: "path",
    required: true,
    description: "The key's `id`. Any other value answers `404`.",
    schema: { type: "string", pattern: "^[0-9a-f]{32}$" }
};

const expiresInDays = {
    type: ["integer", "null"],
    minimum: API_KEY_EXPIRY_MIN_DAYS,
    maximum: API_KEY_EXPIRY_MAX_DAYS,
    description: "Days until the key expires, from now; `null` for a key that never expires."
};

const confirmingPassword = {
    type: "string",
    description: `The account's password. An account without one (made with GitHub) omits it and needs a GitHub login or relink within the last ${GITHUB_REAUTH_MINUTES} minutes from this session instead.`
};

const tokenAnswer = (description: string, message: string) => ({
    description,
    headers: {
        "Cache-Control": { description: "Always `no-store`.", schema: { type: "string" } }
    },
    content: {
        "application/json": {
            schema: {
                type: "object",
                required: ["message", "apiKey"],
                properties: {
                    message: { type: "string" },
                    apiKey: { $ref: "#/components/schemas/NewApiKey" }
                }
            },
            example: {
                message,
                apiKey: {
                    ...apiKeyExample,
                    token: `vbk_${"0".repeat(39)}x9Qk`
                }
            }
        }
    }
});

const confirmationErrors = [
    Responses.Authentication.incorrectPassword,
    Responses.ApiKeys.githubReauthRequired(GITHUB_REAUTH_MINUTES),
    Responses.ApiKeys.adminScopesNotAllowed
];

const confirmationLimited = limitedResponse(
    `After ${FAILED_ATTEMPTS_PER_ACCOUNT} rejected confirmations on this account or ${FAILED_ATTEMPTS_PER_IP} from this IP address in ${duration(FAILED_ATTEMPTS_WINDOW_MS)}, or once the day's ${SECURITY_NOTICES_PER_DAY} security notices of the account are used up: \`retryAfter\` is then the seconds until ${duration(CODE_FAILURES_WINDOW_MS)} after the first one.`,
    Responses.tooManyFailedAttempts,
    Responses.ApiKeys.tooManySecurityNotices
);

const mailBudgetUsedUp = rateLimitedResponse(
    "The site's daily share of mail for security notices is used up, so the key's notice couldn't be sent: nothing changed and the account's notice is given back. `retryAfter` is the seconds until the next UTC midnight.",
    { error: Responses.EmailCodes.mailBudgetUsedUpForAccounts, reason: "mailBudget" }
);

const confirmation = `Needs the password as \`password\`, or on an account without one, a GitHub login or relink within the last ${GITHUB_REAUTH_MINUTES} minutes from this session. Takes one of the account's ${SECURITY_NOTICES_PER_DAY} security notices a day and a mail of the site's daily share for them before the write, and mails it, naming the key and whether it has admin scopes. The token is only in this answer: the API keeps a hash of it.`;

export const tags: DocsModule["tags"] = [
    {
        name: "API keys",
        description:
            "The logged-in user's API keys, sent as `Authorization: Bearer vbk_…` to the operations that list a scope. Managing them needs a session."
    }
];

export const components: DocsModule["components"] = {
    schemas: {
        ApiKey: {
            type: "object",
            required: ["id", "name", "hint", "scopes", "createdAt", "expiresAt", "lastUsedAt"],
            properties: {
                id: { type: "string", pattern: "^[0-9a-f]{32}$" },
                name: { type: "string", minLength: 1, maxLength: API_KEY_NAME_MAX_LENGTH },
                hint: {
                    type: "string",
                    minLength: 4,
                    maxLength: 4,
                    description: "The token's last 4 characters."
                },
                scopes: {
                    type: "array",
                    minItems: 1,
                    uniqueItems: true,
                    items: apiKeyScope,
                    description:
                        "Each allows one kind of request; a `write` scope doesn't include its `read` scope. Only the superuser's keys can have the `admin:` ones. App scopes (`<client>:<scope>`) come from the OAuth client registry and allow nothing here."
                },
                createdAt: {
                    type: "string",
                    format: "date-time",
                    description: "When the key was created or last rotated."
                },
                expiresAt: {
                    type: ["string", "null"],
                    format: "date-time",
                    description: "`null` for a key that never expires."
                },
                lastUsedAt: {
                    type: ["string", "null"],
                    format: "date-time",
                    description: `Updated at most every ${API_KEY_LAST_USE_INTERVAL_MS / 1000} seconds; \`null\` before the first use.`
                }
            }
        },
        NewApiKey: {
            allOf: [
                { $ref: "#/components/schemas/ApiKey" },
                {
                    type: "object",
                    required: ["token"],
                    properties: {
                        token: {
                            type: "string",
                            pattern: "^vbk_[\\w-]{43}$",
                            description: "Shown only once."
                        }
                    }
                }
            ]
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/user/api-keys": {
        get: {
            tags: ["API keys"],
            summary: "List API keys",
            description: "Lists the account's API keys, without their tokens.",
            security: [{ session: [] }],
            responses: {
                "200": {
                    description: "The keys.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["apiKeys"],
                                properties: {
                                    apiKeys: {
                                        type: "array",
                                        maxItems: API_KEYS_MAX,
                                        items: { $ref: "#/components/schemas/ApiKey" }
                                    }
                                }
                            },
                            example: { apiKeys: [apiKeyExample] }
                        }
                    }
                },
                "403": sessionForbiddenResponse(),
                "500": serverError
            }
        },
        post: {
            tags: ["API keys"],
            summary: "Create an API key",
            description: `Creates a key, up to ${API_KEYS_MAX} per account. ${confirmation} The body is checked before the password, so a bad one isn't counted as a password check.`,
            security: [{ session: [] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["name", "scopes"],
                            properties: {
                                name: {
                                    type: "string",
                                    minLength: 1,
                                    description: `Trimmed, then 1 to ${API_KEY_NAME_MAX_LENGTH} characters, without line breaks or invisible formatting characters. Blank after trimming answers the missing-name \`400\`.`
                                },
                                scopes: {
                                    type: "array",
                                    minItems: 1,
                                    uniqueItems: true,
                                    items: apiKeyScope
                                },
                                expiresInDays: {
                                    ...expiresInDays,
                                    default: API_KEY_EXPIRY_DEFAULT_DAYS
                                },
                                password: confirmingPassword
                            }
                        },
                        example: {
                            name: "Deploy bot",
                            scopes: ["pastes:read", "pastes:write"],
                            expiresInDays: 90,
                            password: "correct horse battery staple"
                        }
                    }
                }
            },
            responses: {
                "201": tokenAnswer("The key is created.", Responses.ApiKeys.apiKeyCreatedSuccess),
                "400": errorResponse(
                    "Invalid JSON, a bad `name`, `scopes` or `expiresInDays`, or the password is missing, empty or not a string.",
                    Responses.invalidJson,
                    Responses.ApiKeys.missingName,
                    Responses.ApiKeys.nameTooLong,
                    Responses.ApiKeys.nameInvalidCharacters,
                    Responses.ApiKeys.invalidScopes,
                    Responses.ApiKeys.invalidExpiry,
                    Responses.ApiKeys.missingPassword
                ),
                "403": {
                    ...sessionForbiddenResponse(...confirmationErrors),
                    description:
                        "Refused: not logged in, an `Authorization` header was sent, or another cause listed. Also when the session ended or the confirmation stopped holding while the key was created, unless the account already had the most keys (`409`); an account without a password then gets `githubReauthRequired` instead of `notLoggedIn`."
                },
                "409": errorResponse(
                    "The account already has the most keys it can, or reached it meanwhile. An account that already had the most keys answers this even if its session ends during the request.",
                    Responses.ApiKeys.tooManyApiKeys
                ),
                "413": requestTooLarge,
                "429": confirmationLimited,
                "503": mailBudgetUsedUp,
                "500": serverError
            }
        }
    },
    "/user/api-keys/{id}/rotate": {
        post: {
            tags: ["API keys"],
            summary: "Rotate an API key",
            description: `Gives the key a new token; the old one stops working at once. The name and scopes stay, \`createdAt\` becomes now and \`lastUsedAt\` \`null\`. Without \`expiresInDays\` the key keeps its lifetime, counted from now. ${confirmation}`,
            security: [{ session: [] }],
            parameters: [idParameter],
            requestBody: {
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            properties: { expiresInDays, password: confirmingPassword }
                        },
                        example: { expiresInDays: 30, password: "correct horse battery staple" }
                    }
                }
            },
            responses: {
                "200": tokenAnswer(
                    "The key has a new token.",
                    Responses.ApiKeys.apiKeyRotatedSuccess
                ),
                "400": errorResponse(
                    "Invalid JSON, a bad `expiresInDays`, or the password is missing, empty or not a string.",
                    Responses.invalidJson,
                    Responses.ApiKeys.invalidExpiry,
                    Responses.ApiKeys.missingPassword
                ),
                "403": {
                    ...sessionForbiddenResponse(...confirmationErrors),
                    description:
                        "Refused: not logged in, an `Authorization` header was sent, or another cause listed. Also when the session ended or the confirmation stopped holding while the key was rotated, unless the key was already gone (`404`); an account without a password then gets `githubReauthRequired` instead of `notLoggedIn`."
                },
                "404": errorResponse(
                    "The account has no key with this id, or a parallel request deleted it. A key that was already gone answers this even if the session ends during the request.",
                    Responses.ApiKeys.apiKeyNotFound
                ),
                "409": errorResponse(
                    "A parallel request rotated the key first; nothing changed.",
                    Responses.ApiKeys.apiKeyChanged
                ),
                "413": requestTooLarge,
                "429": confirmationLimited,
                "503": mailBudgetUsedUp,
                "500": serverError
            }
        }
    },
    "/user/api-keys/{id}": {
        delete: {
            tags: ["API keys"],
            summary: "Delete an API key",
            description:
                "Deletes the key at once, with no confirmation, and mails the account a security notice naming it (unless the day's notices are used up).",
            security: [{ session: [] }],
            parameters: [idParameter],
            responses: {
                "200": {
                    description: "The key is deleted.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["message"],
                                properties: { message: { type: "string" } }
                            },
                            example: { message: Responses.ApiKeys.apiKeyDeletedSuccess }
                        }
                    }
                },
                "403": sessionForbiddenResponse(),
                "404": errorResponse(
                    "The account has no key with this id.",
                    Responses.ApiKeys.apiKeyNotFound
                ),
                "500": serverError
            }
        }
    }
};
