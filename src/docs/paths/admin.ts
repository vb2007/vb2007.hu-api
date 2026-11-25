import type { DocsModule } from "../openapi";
import { Responses } from "../../constants/responses";
import {
    EMAIL_CODE_MAX_ATTEMPTS,
    LIST_MAX_LIMIT,
    LIST_QUERY_MAX_LENGTH,
    OWNER_SEARCH_MAX_USERS,
    PASTE_PREVIEW_LENGTH,
    PENDING_REGISTRATION_HOURS,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH
} from "../../constants/limits";
import { pasteSortFields } from "../../database/pastebin";
import { shortUrlSortFields } from "../../database/shortUrls";
import { userSortFields } from "../../database/users";
import { sortOrders, uploadSortFields, uploadVisibilities } from "../../database/userUploads";
import {
    apiKeyForbiddenResponse,
    apiKeyResponses,
    errorResponse,
    jsonBody,
    objectIdParameter,
    requestTooLarge,
    serverError,
    sessionForbiddenResponse
} from "../components";

type AdminScope = "admin:read" | "admin:write";

const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const parameter = (name: string) => ({ $ref: `#/components/parameters/${name}` });

const json = (description: string, body: object, example: unknown) => ({
    description,
    content: { "application/json": { schema: body, example } }
});

const nullable = (type: string, extra: object = {}) => ({ type: [type, "null"], ...extra });

const sortedByStatus = (responses: Record<string, object>) =>
    Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b)));

const adminOperation = (
    scope: AdminScope,
    { responses, ...operation }: { responses: Record<string, object>; [field: string]: unknown }
) => ({
    tags: ["Admin"],
    ...operation,
    security: [{ session: [] as string[] }, { apiKey: [scope] }],
    responses: sortedByStatus({
        ...responses,
        ...apiKeyResponses,
        "403": apiKeyForbiddenResponse(scope, Responses.notAuthorized)
    })
});

const invalidQuery = (...params: string[]): string[] =>
    params.map((param: string): string => Responses.invalidQuery(param));

const queryRules = `Repeating a parameter, or an empty value for any but \`q\`, is invalid. An empty \`q\` means no filter, and unknown parameters are ignored.`;

const invalidQueryResponse = (...params: string[]) =>
    errorResponse(
        `An invalid query parameter: the error names the first one, in the order ${params.map((param: string) => `\`${param}\``).join(", ")}.`,
        ...invalidQuery(...params)
    );

const listQuery = (description: string) => ({
    name: "q",
    in: "query",
    description: `${description} Case-insensitive, at most ${LIST_QUERY_MAX_LENGTH} UTF-16 code units (most emoji take 2), without a NUL character.`,
    schema: { type: "string" }
});

const ownerCap = `The owner match covers only the ${OWNER_SEARCH_MAX_USERS} shortest usernames containing \`q\` (the oldest account first among names of the same length), so a broad \`q\` can miss some owners' items, while a full username always finds its owner.`;

const superuserKeyNote =
    "With an API key, that owner-check bypass also needs `admin:write` on the key.";

const userNotFound = errorResponse("No user has this ID.", Responses.Admin.userNotFound);

const exampleUserId = "64b7f0c2a1b2c3d4e5f60718";
const exampleOwner = { id: exampleUserId, username: "example" };
const exampleUser = {
    id: exampleUserId,
    username: "example",
    email: "example@example.com",
    createdAt: "2026-01-15T10:00:00.000Z",
    isSuperuser: false,
    suspendedAt: null as string | null,
    uploads: { usedBytes: 140, count: 2, quotaBytes: 10737418240, hasCustomQuota: false }
};
const exampleUpload = {
    id: "64b7f1d3b2c3d4e5f6071829",
    originalFileName: "photo.png",
    extension: ".png",
    mimeType: "image/png",
    fileSize: 70,
    visibility: "private",
    url: `https://cdn.vb2007.hu/useruploads/${exampleUserId}/64b7f1d3b2c3d4e5f6071829.png?expires=1768475100&sig=SIGNATURE`,
    uploadedOn: "2026-01-15T10:05:00.000Z",
    updatedOn: "2026-01-15T10:05:00.000Z"
};
const examplePagination = (sortBy: string) => ({
    limit: 20,
    page: 1,
    total: 1,
    pages: 1,
    sortBy,
    sortOrder: "desc"
});

const userMessage = (description: string, message: string, user: object = exampleUser) =>
    json(description, schema("AdminUserMessage"), { message, user });

const ownerMessage = (description: string, body: object, example: object) =>
    json(
        description,
        {
            type: "object",
            required: ["message", "user", ...Object.keys(body)],
            properties: { message: { type: "string" }, user: schema("AdminOwner"), ...body }
        },
        example
    );

const message = (description: string, text: string) =>
    json(description, schema("AdminMessage"), { message: text });

const uploadListParameters = [
    parameter("AdminLimit"),
    parameter("AdminPage"),
    parameter("AdminUploadSortBy"),
    parameter("AdminSortOrder"),
    parameter("AdminUploadVisibility")
];

const uploadListParams = ["limit", "page", "sortBy", "sortOrder", "visibility", "q"];

const addedOnParameters = (sortFields: readonly string[]) => [
    parameter("AdminLimit"),
    parameter("AdminPage"),
    {
        name: "sortBy",
        in: "query",
        schema: { type: "string", enum: [...sortFields], default: sortFields[0] }
    },
    parameter("AdminSortOrder")
];

const addedOnParams = ["limit", "page", "sortBy", "sortOrder", "q"];

export const tags: DocsModule["tags"] = [
    {
        name: "Admin",
        description:
            "Superuser-only routes: users, their quotas, suspensions, sessions, MFA and API keys, every upload, short URL and paste, pending registrations, the site's totals, the mail budget and rate-limit lockouts. The superuser is the account whose e-mail matches `SUPERUSER_EMAIL`. Its API keys with `admin:read` or `admin:write` work on every route but `DELETE /admin/rate-limits`, which needs the session, and can't log out the superuser's own account through `POST /admin/users/{id}/logout`. An `admin:read` key gets signed links to every private upload from `GET /admin/uploads` and `GET /admin/users/{id}/uploads`, so guard it like an `admin:write` one. The admin scopes are checked against `SUPERUSER_EMAIL` on every request: once it moves, the old account's admin keys answer `403` but stay listed, and work again if it moves back, so revoke them with `DELETE /admin/users/{id}/api-keys`."
    }
];

export const components: DocsModule["components"] = {
    parameters: {
        AdminUserId: objectIdParameter("The user's ID.", exampleUserId),
        AdminLimit: {
            name: "limit",
            in: "query",
            description: "Items per page.",
            schema: { type: "integer", minimum: 1, maximum: LIST_MAX_LIMIT, default: 20 }
        },
        AdminPage: {
            name: "page",
            in: "query",
            description:
                "The page, from 1. A page past the last one answers `200` with an empty list.",
            schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 }
        },
        AdminSortOrder: {
            name: "sortOrder",
            in: "query",
            schema: { type: "string", enum: [...sortOrders], default: "desc" }
        },
        AdminUploadSortBy: {
            name: "sortBy",
            in: "query",
            description: "`originalFileName` sorts case-insensitively.",
            schema: {
                type: "string",
                enum: [...uploadSortFields],
                default: "uploadedOn"
            }
        },
        AdminUploadVisibility: {
            name: "visibility",
            in: "query",
            description:
                "Only uploads with this visibility; `private` also covers uploads stored without one. Both when left out.",
            schema: { type: "string", enum: [...uploadVisibilities] }
        }
    },
    schemas: {
        AdminOwner: {
            type: "object",
            required: ["id", "username"],
            properties: { id: { type: "string" }, username: { type: "string" } },
            example: exampleOwner
        },
        AdminMessage: {
            type: "object",
            required: ["message"],
            properties: { message: { type: "string" } }
        },
        AdminUser: {
            type: "object",
            required: [
                "id",
                "username",
                "email",
                "createdAt",
                "isSuperuser",
                "suspendedAt",
                "uploads"
            ],
            properties: {
                id: { type: "string" },
                username: { type: "string" },
                email: { type: "string", format: "email" },
                createdAt: {
                    type: "string",
                    format: "date-time",
                    description:
                        "Falls back to the ID's timestamp for users made before the field existed."
                },
                isSuperuser: { type: "boolean" },
                suspendedAt: nullable("string", {
                    format: "date-time",
                    description: "When the user was suspended, `null` while they aren't."
                }),
                uploads: {
                    type: "object",
                    required: ["usedBytes", "count", "quotaBytes", "hasCustomQuota"],
                    properties: {
                        usedBytes: { type: "integer", minimum: 0 },
                        count: { type: "integer", minimum: 0 },
                        quotaBytes: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "The user's own quota when `hasCustomQuota` is `true`, otherwise the default from `UPLOAD_USER_QUOTA_MB`."
                        },
                        hasCustomQuota: { type: "boolean" }
                    }
                }
            },
            example: exampleUser
        },
        AdminUserMessage: {
            type: "object",
            required: ["message", "user"],
            properties: { message: { type: "string" }, user: schema("AdminUser") }
        },
        AdminUserDetails: {
            allOf: [
                schema("AdminUser"),
                {
                    type: "object",
                    required: [
                        "hasPassword",
                        "emailVerified",
                        "pendingEmail",
                        "mfa",
                        "githubLogin",
                        "counts",
                        "apiKeys"
                    ],
                    properties: {
                        hasPassword: {
                            type: "boolean",
                            description: "`false` for an account that only logs in with GitHub."
                        },
                        emailVerified: { type: "boolean" },
                        pendingEmail: nullable("string", {
                            format: "email",
                            description: `The address of an unconfirmed e-mail change that hasn't expired or used up its ${EMAIL_CODE_MAX_ATTEMPTS} tries.`
                        }),
                        mfa: {
                            type: "object",
                            required: ["email", "totp", "passkeys", "recoveryCodesLeft"],
                            properties: {
                                email: { type: "boolean" },
                                totp: { type: "boolean" },
                                passkeys: { type: "integer", minimum: 0 },
                                recoveryCodesLeft: { type: "integer", minimum: 0 }
                            }
                        },
                        githubLogin: nullable("string", {
                            description: "The linked GitHub username."
                        }),
                        counts: {
                            type: "object",
                            required: ["pastes", "shortUrls", "uploads"],
                            properties: {
                                pastes: { type: "integer", minimum: 0 },
                                shortUrls: { type: "integer", minimum: 0 },
                                uploads: { type: "integer", minimum: 0 }
                            }
                        },
                        apiKeys: { type: "array", items: schema("ApiKey") }
                    }
                }
            ]
        },
        AdminPagination: {
            type: "object",
            required: ["limit", "page", "total", "pages", "sortBy", "sortOrder"],
            properties: {
                limit: { type: "integer" },
                page: { type: "integer" },
                total: { type: "integer", description: "Items matching the filters." },
                pages: { type: "integer", description: "`0` when nothing matches." },
                sortBy: { type: "string" },
                sortOrder: { type: "string", enum: [...sortOrders] }
            }
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/admin/users": {
        get: adminOperation("admin:read", {
            summary: "List users",
            description: `Lists users with their upload usage and quota. ${queryRules}`,
            parameters: [
                parameter("AdminLimit"),
                parameter("AdminPage"),
                {
                    name: "sortBy",
                    in: "query",
                    description: "`username` sorts case-insensitively.",
                    schema: {
                        type: "string",
                        enum: [...userSortFields],
                        default: "usedBytes"
                    }
                },
                parameter("AdminSortOrder"),
                listQuery("Part of the username or e-mail address.")
            ],
            responses: {
                "200": json(
                    "A page of users.",
                    {
                        type: "object",
                        required: ["users", "pagination"],
                        properties: {
                            users: { type: "array", items: schema("AdminUser") },
                            pagination: schema("AdminPagination")
                        }
                    },
                    { users: [exampleUser], pagination: examplePagination("usedBytes") }
                ),
                "400": invalidQueryResponse("limit", "page", "sortBy", "sortOrder", "q")
            }
        })
    },
    "/admin/users/{id}": {
        parameters: [parameter("AdminUserId")],
        get: adminOperation("admin:read", {
            summary: "Get a user",
            description:
                "Shows one user's details: account status like `GET /user` gives it, how much content they own, and their API keys.",
            responses: {
                "200": json(
                    "The user.",
                    {
                        type: "object",
                        required: ["user"],
                        properties: { user: schema("AdminUserDetails") }
                    },
                    {
                        user: {
                            ...exampleUser,
                            hasPassword: true,
                            emailVerified: true,
                            pendingEmail: null,
                            mfa: { email: false, totp: false, passkeys: 0, recoveryCodesLeft: 0 },
                            githubLogin: null,
                            counts: { pastes: 3, shortUrls: 1, uploads: 2 },
                            apiKeys: [
                                {
                                    id: "3f0c9a7e5b1d4c2a8e6f0b9d7c5a3e1f",
                                    name: "Deploy bot",
                                    hint: "x9Qk",
                                    scopes: ["pastes:read", "pastes:write"],
                                    createdAt: "2026-11-21T10:00:00.000Z",
                                    expiresAt: "2027-02-19T10:00:00.000Z",
                                    lastUsedAt: null
                                }
                            ]
                        }
                    }
                ),
                "400": errorResponse("`id` isn't an ID.", Responses.Database.invalidIdFormat),
                "404": userNotFound
            }
        }),
        patch: adminOperation("admin:write", {
            summary: "Rename a user",
            description:
                "Renames the user by the same rules as `PATCH /users/{id}`. Another case of their own name is allowed. The superuser can rename their own account too: superuser status follows the e-mail address.",
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["username"],
                    properties: {
                        username: {
                            type: "string",
                            description: `${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters after trimming: at most ${USERNAME_MAX_LENGTH} UTF-16 code units (most emoji take 2), and at least ${USERNAME_MIN_LENGTH} characters not counting combining marks. No invisible or control characters, or whitespace other than spaces.`
                        }
                    }
                },
                { username: "renamed" }
            ),
            responses: {
                "200": userMessage("Renamed.", Responses.Admin.userRenamedSuccess, {
                    ...exampleUser,
                    username: "renamed"
                }),
                "400": errorResponse(
                    "Invalid JSON, an invalid `id`, or an invalid `username`, checked after the user exists.",
                    Responses.invalidJson,
                    Responses.Database.invalidIdFormat,
                    Responses.Users.missingUsername,
                    Responses.Authentication.usernameTooLong,
                    Responses.Authentication.usernameInvalidCharacters,
                    Responses.Authentication.usernameTooShort
                ),
                "404": errorResponse(
                    "No user has this ID, checked before `username`, or the user was deleted while the request ran.",
                    Responses.Admin.userNotFound
                ),
                "409": errorResponse(
                    "Another user has the name, or one that counts as the same (e.g. another case).",
                    Responses.Authentication.usernameTaken
                ),
                "413": requestTooLarge
            }
        }),
        delete: adminOperation("admin:write", {
            summary: "Delete a user",
            description:
                "Deletes the user with their pastes, short URLs, upload records and upload folder, and so ends their session. No password re-check. The superuser's own account can't be deleted.",
            responses: {
                "200": message("Deleted.", Responses.Admin.userDeletedSuccess),
                "400": errorResponse("`id` isn't an ID.", Responses.Database.invalidIdFormat),
                "404": userNotFound,
                "409": errorResponse(
                    "`id` is the superuser's account.",
                    Responses.Admin.cannotDeleteSuperuser
                )
            }
        })
    },
    "/admin/users/{id}/upload-quota": {
        parameters: [parameter("AdminUserId")],
        patch: adminOperation("admin:write", {
            summary: "Set a user's upload quota",
            description:
                "Sets the user's upload quota, or resets it to the default with `null`. A quota below the user's usage is accepted: their files stay, but every new upload answers `413` (or `409` first while the account is at the upload cap).",
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["quotaBytes"],
                    properties: {
                        quotaBytes: nullable("integer", {
                            minimum: 0,
                            maximum: Number.MAX_SAFE_INTEGER,
                            description:
                                "The quota in bytes, or `null` to go back to the default quota."
                        })
                    }
                },
                { quotaBytes: 1073741824 }
            ),
            responses: {
                "200": userMessage("The quota is set.", Responses.Admin.quotaUpdatedSuccess, {
                    ...exampleUser,
                    uploads: {
                        ...exampleUser.uploads,
                        quotaBytes: 1073741824,
                        hasCustomQuota: true
                    }
                }),
                "400": errorResponse(
                    'Invalid JSON, an invalid `id`, or `quotaBytes` missing, negative, fractional, too large or not a number (e.g. `"100"`), checked after the user exists.',
                    Responses.invalidJson,
                    Responses.Database.invalidIdFormat,
                    Responses.Admin.invalidQuota
                ),
                "404": errorResponse(
                    "No user has this ID, checked before `quotaBytes`, or the user was deleted while the request ran.",
                    Responses.Admin.userNotFound
                ),
                "413": requestTooLarge
            }
        })
    },
    "/admin/users/{id}/suspension": {
        parameters: [parameter("AdminUserId")],
        patch: adminOperation("admin:write", {
            summary: "Suspend or unsuspend a user",
            description:
                "`true` suspends the user: it ends their session, deletes their API keys and unused OAuth sign-in codes, cancels a waiting MFA login, and voids their pending password reset codes and links, e-mail change and GitHub link start. A suspended user can't log in, and password reset and registration resend mail nothing to their address. Their pastes, short URLs and uploads stay up. Suspending again keeps the first `suspendedAt`. `false` lifts it and clears the same fields and codes again; for a user who isn't suspended it changes nothing. The superuser can't be suspended.",
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["suspended"],
                    properties: { suspended: { type: "boolean" } }
                },
                { suspended: true }
            ),
            responses: {
                "200": {
                    description: "Suspended or unsuspended.",
                    content: {
                        "application/json": {
                            schema: schema("AdminUserMessage"),
                            examples: {
                                suspended: {
                                    summary: Responses.Admin.userSuspendedSuccess,
                                    value: {
                                        message: Responses.Admin.userSuspendedSuccess,
                                        user: {
                                            ...exampleUser,
                                            suspendedAt: "2026-11-22T10:00:00.000Z"
                                        }
                                    }
                                },
                                unsuspended: {
                                    summary: Responses.Admin.userUnsuspendedSuccess,
                                    value: {
                                        message: Responses.Admin.userUnsuspendedSuccess,
                                        user: exampleUser
                                    }
                                }
                            }
                        }
                    }
                },
                "400": errorResponse(
                    'Invalid JSON, an invalid `id`, or `suspended` missing or not a boolean (e.g. `"true"` or `1`), checked after the user exists.',
                    Responses.invalidJson,
                    Responses.Database.invalidIdFormat,
                    Responses.Admin.invalidSuspension
                ),
                "404": errorResponse(
                    "No user has this ID, checked before `suspended`, or the user was deleted while the request ran.",
                    Responses.Admin.userNotFound
                ),
                "409": errorResponse(
                    "The user is the superuser.",
                    Responses.Admin.superuserSuspension
                ),
                "413": requestTooLarge
            }
        })
    },
    "/admin/users/{id}/uploads": {
        parameters: [parameter("AdminUserId")],
        get: adminOperation("admin:read", {
            summary: "List a user's uploads",
            description: `Lists the user's uploads, private ones included. ${queryRules}`,
            parameters: [...uploadListParameters, listQuery("Part of the original file name.")],
            responses: {
                "200": json(
                    "A page of the user's uploads.",
                    {
                        type: "object",
                        required: ["user", "uploads", "pagination"],
                        properties: {
                            user: schema("AdminOwner"),
                            uploads: { type: "array", items: schema("Upload") },
                            pagination: schema("AdminPagination")
                        }
                    },
                    {
                        user: exampleOwner,
                        uploads: [exampleUpload],
                        pagination: examplePagination("uploadedOn")
                    }
                ),
                "400": errorResponse(
                    `An invalid \`id\`, or an invalid query parameter, checked before the user exists: the error names the first one, in the order ${uploadListParams.map((param: string) => `\`${param}\``).join(", ")}.`,
                    Responses.Database.invalidIdFormat,
                    ...invalidQuery(...uploadListParams)
                ),
                "404": userNotFound
            }
        })
    },
    "/admin/uploads": {
        get: adminOperation("admin:read", {
            summary: "List every upload",
            description: `Lists every user's uploads, private ones included, with their owners. ${ownerCap} The superuser reads, edits and deletes any upload through \`/upload/{id}\`. ${superuserKeyNote} ${queryRules}`,
            parameters: [
                ...uploadListParameters,
                listQuery("Part of the original file name or of the owner's username.")
            ],
            responses: {
                "200": json(
                    "A page of uploads.",
                    {
                        type: "object",
                        required: ["uploads", "pagination"],
                        properties: {
                            uploads: {
                                type: "array",
                                items: {
                                    allOf: [
                                        schema("Upload"),
                                        {
                                            type: "object",
                                            required: ["owner"],
                                            properties: {
                                                owner: {
                                                    oneOf: [schema("AdminOwner"), { type: "null" }],
                                                    description:
                                                        "`null` when the owner's account no longer exists."
                                                }
                                            }
                                        }
                                    ]
                                }
                            },
                            pagination: schema("AdminPagination")
                        }
                    },
                    {
                        uploads: [{ ...exampleUpload, owner: exampleOwner }],
                        pagination: examplePagination("uploadedOn")
                    }
                ),
                "400": invalidQueryResponse(...uploadListParams)
            }
        })
    },
    "/admin/short-urls": {
        get: adminOperation("admin:read", {
            summary: "List every short URL",
            description: `Lists every short URL with its owner. ${ownerCap} The superuser deletes any of them with \`DELETE /shortenUrl/{shortenedUrl}\`. ${superuserKeyNote} ${queryRules}`,
            parameters: [
                ...addedOnParameters(shortUrlSortFields),
                listQuery("Part of the code, the target URL or the owner's username.")
            ],
            responses: {
                "200": json(
                    "A page of short URLs.",
                    {
                        type: "object",
                        required: ["shortUrls", "pagination"],
                        properties: {
                            shortUrls: {
                                type: "array",
                                items: {
                                    type: "object",
                                    required: ["shortenedUrl", "originalUrl", "addedOn", "owner"],
                                    properties: {
                                        shortenedUrl: { type: "string" },
                                        originalUrl: { type: "string" },
                                        addedOn: { type: "string", format: "date-time" },
                                        owner: {
                                            oneOf: [schema("AdminOwner"), { type: "null" }],
                                            description:
                                                "`null` when the owner's account no longer exists."
                                        }
                                    }
                                }
                            },
                            pagination: schema("AdminPagination")
                        }
                    },
                    {
                        shortUrls: [
                            {
                                shortenedUrl: "aB3dE9",
                                originalUrl: "https://example.com/",
                                addedOn: "2026-01-15T10:10:00.000Z",
                                owner: exampleOwner
                            }
                        ],
                        pagination: examplePagination("addedOn")
                    }
                ),
                "400": invalidQueryResponse(...addedOnParams)
            }
        })
    },
    "/admin/pastes": {
        get: adminOperation("admin:read", {
            summary: "List every paste",
            description: `Lists every paste with a short preview and its owner, for moderation. ${ownerCap} The full content stays on \`GET /paste/{id}\`, and the superuser deletes any paste with \`DELETE /paste/{id}\`. ${superuserKeyNote} ${queryRules}`,
            parameters: [
                ...addedOnParameters(pasteSortFields),
                listQuery("Part of the owner's username or of the language.")
            ],
            responses: {
                "200": json(
                    "A page of pastes.",
                    {
                        type: "object",
                        required: ["pastes", "pagination"],
                        properties: {
                            pastes: {
                                type: "array",
                                items: {
                                    type: "object",
                                    required: ["id", "language", "preview", "addedOn", "owner"],
                                    properties: {
                                        id: { type: "string" },
                                        language: nullable("string"),
                                        preview: {
                                            type: "string",
                                            description: `The paste's first ${PASTE_PREVIEW_LENGTH} characters (code points).`
                                        },
                                        addedOn: { type: "string", format: "date-time" },
                                        owner: {
                                            oneOf: [schema("AdminOwner"), { type: "null" }],
                                            description:
                                                "`null` when the owner's account no longer exists. Such a paste is found by `q` only through its language."
                                        }
                                    }
                                }
                            },
                            pagination: schema("AdminPagination")
                        }
                    },
                    {
                        pastes: [
                            {
                                id: "64b7f2e4c3d4e5f607182930",
                                language: "typescript",
                                preview: "const answer: number = 42;",
                                addedOn: "2026-01-15T10:10:00.000Z",
                                owner: exampleOwner
                            }
                        ],
                        pagination: examplePagination("addedOn")
                    }
                ),
                "400": invalidQueryResponse(...addedOnParams)
            }
        })
    },
    "/admin/mail-budget": {
        get: adminOperation("admin:read", {
            summary: "Get the mail budget",
            description:
                "Reports the daily mail limit as this API process counts it. The count lives in memory: it starts from `0` on every restart, counts only this process, and can be below the SMTP provider's own count.",
            responses: {
                "200": json(
                    "Today's mail budget.",
                    {
                        type: "object",
                        required: [
                            "sentToday",
                            "dailyLimit",
                            "warningAt",
                            "registrationStopsAt",
                            "passwordResetStopsAt",
                            "resetsAt"
                        ],
                        properties: {
                            sentToday: {
                                type: "integer",
                                minimum: 0,
                                description:
                                    "Mails sent, or being handed to SMTP, since the last UTC midnight or restart. A failed send is taken back. A registration resend, and a password reset below `registrationStopsAt`, count from their request, unless SMTP isn't set or the address is on a reserved test domain."
                            },
                            dailyLimit: {
                                type: "integer",
                                minimum: 1,
                                description:
                                    "`MAIL_DAILY_LIMIT`, `250` when unset or invalid. At it, every mail is refused."
                            },
                            warningAt: {
                                type: "integer",
                                description:
                                    "80 % of `dailyLimit`, rounded up: from it the API logs a warning once a day."
                            },
                            registrationStopsAt: {
                                type: "integer",
                                description:
                                    "`dailyLimit` less a fifth, rounded up: from it registration codes, their resends and security notices are refused."
                            },
                            passwordResetStopsAt: {
                                type: "integer",
                                description:
                                    "`dailyLimit` less a tenth, rounded up: from it password reset codes are refused, while e-mail change codes go on."
                            },
                            resetsAt: {
                                type: "string",
                                format: "date-time",
                                description: "The next UTC midnight."
                            }
                        }
                    },
                    {
                        sentToday: 12,
                        dailyLimit: 250,
                        warningAt: 200,
                        registrationStopsAt: 200,
                        passwordResetStopsAt: 225,
                        resetsAt: "2026-11-23T00:00:00.000Z"
                    }
                )
            }
        })
    },
    "/admin/users/{id}/logout": {
        parameters: [parameter("AdminUserId")],
        post: adminOperation("admin:write", {
            summary: "Log a user out",
            description:
                "Ends the user's session on every device and cancels a login waiting for its MFA step. It answers `200` when they weren't logged in too. With the superuser's own ID it also ends the caller's session; an API key can't do that, so a leaked key can't keep logging the superuser out. API keys keep working: revoke them with `DELETE /admin/users/{id}/api-keys`. A suspension or an MFA reset ends the session and deletes the keys in one write.",
            responses: {
                "200": ownerMessage(
                    "Logged out.",
                    {},
                    { message: Responses.Admin.userLoggedOutSuccess, user: exampleOwner }
                ),
                "400": errorResponse("`id` isn't an ID.", Responses.Database.invalidIdFormat),
                "404": userNotFound,
                "409": errorResponse(
                    "An API key sent the superuser's own ID.",
                    Responses.Admin.superuserLogout
                )
            }
        })
    },
    "/admin/users/{id}/api-keys": {
        parameters: [parameter("AdminUserId")],
        delete: adminOperation("admin:write", {
            summary: "Revoke a user's API keys",
            description:
                "Deletes every API key of the user, the superuser's own included. Their session stays. When any were revoked, the user is mailed a security notice, unless the account's daily notice limit or the site's mail budget (`registrationStopsAt` in `GET /admin/mail-budget`) is used up.",
            responses: {
                "200": ownerMessage(
                    "Revoked.",
                    {
                        revoked: {
                            type: "integer",
                            minimum: 0,
                            description: "How many keys were deleted."
                        }
                    },
                    {
                        message: Responses.Admin.userApiKeysRevokedSuccess,
                        user: exampleOwner,
                        revoked: 2
                    }
                ),
                "400": errorResponse("`id` isn't an ID.", Responses.Database.invalidIdFormat),
                "404": userNotFound
            }
        })
    },
    "/admin/users/{id}/mfa": {
        parameters: [parameter("AdminUserId")],
        delete: adminOperation("admin:write", {
            summary: "Reset a user's MFA",
            description:
                "For a user who lost their second factor: turns off every MFA method in one write, also deleting the recovery codes and removing a login waiting for its MFA step, the daily wrong-code count, and the e-mail MFA mail count and cooldown, and ends their session and deletes their API keys. Passkeys stay. No password re-check. It answers `200` when no method was on too. The user is then mailed a security notice, unless the account's daily notice limit or the site's mail budget (`registrationStopsAt` in `GET /admin/mail-budget`) is used up. The superuser's own MFA can't be reset here.",
            responses: {
                "200": message("Reset.", Responses.Admin.userMfaResetSuccess),
                "400": errorResponse("`id` isn't an ID.", Responses.Database.invalidIdFormat),
                "404": errorResponse(
                    "No user has this ID, or the user was deleted while the request ran.",
                    Responses.Admin.userNotFound
                ),
                "409": errorResponse(
                    "`id` is the superuser's account.",
                    Responses.Admin.superuserMfaReset
                )
            }
        })
    },
    "/admin/stats": {
        get: adminOperation("admin:read", {
            summary: "Get site stats",
            description:
                "Returns the site's totals and upload settings. `users`, `pastes` and `shortUrls` count everything, the superuser's included.",
            responses: {
                "200": json(
                    "The totals.",
                    {
                        type: "object",
                        required: [
                            "users",
                            "pastes",
                            "shortUrls",
                            "uploads",
                            "pendingRegistrations",
                            "settings"
                        ],
                        properties: {
                            users: { type: "integer", minimum: 0 },
                            pastes: { type: "integer", minimum: 0 },
                            shortUrls: { type: "integer", minimum: 0 },
                            uploads: {
                                type: "object",
                                required: ["total", "public", "private", "storedBytes"],
                                properties: {
                                    total: { type: "integer", minimum: 0 },
                                    public: { type: "integer", minimum: 0 },
                                    private: {
                                        type: "integer",
                                        minimum: 0,
                                        description:
                                            "Uploads without a stored visibility count as private."
                                    },
                                    storedBytes: {
                                        type: "integer",
                                        minimum: 0,
                                        description: "The sum of every upload's file size."
                                    }
                                }
                            },
                            pendingRegistrations: {
                                type: "integer",
                                minimum: 0,
                                description: `Sign-ups waiting for their e-mail code whose ${PENDING_REGISTRATION_HOURS}-hour registration hasn't expired.`
                            },
                            settings: {
                                type: "object",
                                required: ["defaultUploadQuotaBytes", "maxFileSizeBytes"],
                                properties: {
                                    defaultUploadQuotaBytes: {
                                        type: "integer",
                                        description:
                                            "The quota of users without their own, from `UPLOAD_USER_QUOTA_MB`."
                                    },
                                    maxFileSizeBytes: {
                                        type: "integer",
                                        description:
                                            "The largest file one upload takes, from `UPLOAD_MAX_FILESIZE`."
                                    }
                                }
                            }
                        }
                    },
                    {
                        users: 42,
                        pastes: 120,
                        shortUrls: 35,
                        uploads: { total: 80, public: 12, private: 68, storedBytes: 524288000 },
                        pendingRegistrations: 3,
                        settings: {
                            defaultUploadQuotaBytes: 10737418240,
                            maxFileSizeBytes: 104857600
                        }
                    }
                )
            }
        })
    },
    "/admin/rate-limits": {
        delete: {
            tags: ["Admin"],
            summary: "Clear rate limits",
            description: `Clears the in-memory rate-limit counters of an e-mail address, a client IP, an OAuth client (\`clientId\`) or several of them, e.g. for an owner locked out of \`POST /auth/login\`. An \`email\` also clears the counters keyed by its account and the daily counts stored for its account or waiting registration (only an account's current address finds it). An \`ip\` can't narrow those. To lift a usual login lockout, send the \`email\` alone (every IP) or with the \`ip\` (that IP only). The counters live only in this API process and a restart clears them all.

It needs the superuser's session, not an API key: it clears the brute-force limits of any account, the superuser's own included.

| Name | Key | Counts |
| --- | --- | --- |
| \`loginPerIp\` | \`ip\` | Failed logins per IP |
| \`loginPerAccount\` | \`email\`, narrowed by \`ip\` | Failed logins per address from one IP |
| \`loginPerEmail\` | \`email\` | Failed logins per address, each remembered device on its own |
| \`codeChecksPerIp\` | \`ip\` | Wrong registration and password reset codes, and wrong MFA codes, passkeys and link tokens, per IP |
| \`codeChecksPerEmail\` | \`email\` | Wrong registration and password reset codes per address |
| \`resetLinkChecksPerIp\` | \`ip\` | Rejected password reset link tokens per IP |
| \`mailSendsPerIp\` | \`ip\` | Successful requests to the mail-sending routes per IP, whether or not a mail went out |
| \`usernameChecksPerIp\` | \`ip\` | Username availability checks per IP |
| \`accountCodeChecksPerIp\` | \`ip\` | Wrong e-mail change and TOTP setup codes per IP |
| \`accountCodeChecksPerAccount\` | the account's \`email\` | The same per account |
| \`passwordChecksPerIp\` | \`ip\` | Failed password checks of logged-in routes per IP |
| \`passwordChecksPerAccount\` | the account's \`email\` | The same per account |
| \`passkeyOptionsPerIp\` | \`ip\` | Passkey options requests per IP |
| \`passkeyLoginsPerIp\` | \`ip\` | Failed passkey logins per IP |
| \`apiKeyChecksPerIp\` | \`ip\` | Rejected API keys per IP, shared by every client behind it, e.g. a NAT |
| \`clientChecksPerIp\` | \`ip\` | Rejected OAuth client credentials per IP |
| \`accountStatusPerClient\` | \`clientId\` | Account status requests per OAuth client in a minute |
| \`authorizationsPerAccount\` | the account's \`email\` | OAuth authorization requests per account in a minute |
| \`tokenExchangesPerClient\` | \`clientId\` | Failed OAuth token exchanges per client |
| \`inactiveIntrospectionsPerClient\` | \`clientId\` | Inactive API key introspections per OAuth client |
| \`passwordResetCodeFailures\` | the account's \`email\` | Stored: wrong password reset codes a day |
| \`emailChangeCodeFailures\` | the account's \`email\` | Stored: wrong e-mail change codes a day |
| \`emailChangeSends\` | the account's \`email\` | Stored: e-mail change codes mailed a day |
| \`registrationCodeFailures\` | the waiting registration's \`email\` | Stored: wrong registration codes a day |
| \`mfaCodeFailures\` | the account's \`email\` | Stored: wrong MFA codes, passkeys and link tokens a day |
| \`mfaEmailSends\` | the account's \`email\` | Stored: MFA login mails a day |
| \`securityNotices\` | the account's \`email\` | Stored: security notices mailed a day |`,
            security: [{ session: [] }],
            requestBody: jsonBody(
                {
                    type: "object",
                    anyOf: [
                        { required: ["email"] },
                        { required: ["ip"] },
                        { required: ["clientId"] }
                    ],
                    properties: {
                        email: {
                            type: "string",
                            minLength: 1,
                            description:
                                "Not blank. Normalised like the limiters do: trimmed and lowercase."
                        },
                        ip: {
                            type: "string",
                            description:
                                "An IPv4 or IPv6 address. An IPv6 address clears its /56 for the per-IP limiters and its /48 for `loginPerAccount`, as they count it."
                        },
                        clientId: {
                            type: "string",
                            description: "A registered OAuth client's id."
                        }
                    }
                },
                { email: "example@example.com", ip: "203.0.113.7" }
            ),
            responses: {
                "200": json(
                    "Cleared.",
                    {
                        type: "object",
                        required: ["message", "cleared"],
                        properties: {
                            message: { type: "string" },
                            cleared: {
                                type: "array",
                                items: { type: "string" },
                                description:
                                    "The limiters and stored counts from the table that were counting for the key, in its order. A stored count is removed even when its day is up, but only listed while it still counts. It can show whether an address has an account or a waiting registration."
                            }
                        }
                    },
                    {
                        message: Responses.Admin.rateLimitsCleared,
                        cleared: ["loginPerIp", "loginPerAccount", "loginPerEmail"]
                    }
                ),
                "400": errorResponse(
                    "Invalid JSON, none of `email`, `ip` and `clientId` given, a blank or non-string `email`, an invalid `ip`, or a `clientId` that isn't a registered client's, checked in that order.",
                    Responses.invalidJson,
                    Responses.Admin.rateLimitTargetMissing,
                    Responses.Admin.invalidRateLimitEmail,
                    Responses.Admin.invalidRateLimitIp,
                    Responses.Admin.invalidRateLimitClientId
                ),
                "403": sessionForbiddenResponse(Responses.notAuthorized),
                "413": requestTooLarge,
                "500": serverError
            }
        }
    },
    "/admin/pending-registrations": {
        get: adminOperation("admin:read", {
            summary: "List pending registrations",
            description: `Lists the sign-ups started with \`POST /auth/register\` whose code hasn't been verified and whose ${PENDING_REGISTRATION_HOURS}-hour registration hasn't expired, newest first by \`expiresAt\`. A pending registration holds only the e-mail address; its code and attempts are never returned. ${queryRules}`,
            parameters: [
                parameter("AdminLimit"),
                parameter("AdminPage"),
                listQuery("Part of the e-mail address.")
            ],
            responses: {
                "200": json(
                    "A page of pending registrations.",
                    {
                        type: "object",
                        required: ["pendingRegistrations", "pagination"],
                        properties: {
                            pendingRegistrations: {
                                type: "array",
                                items: {
                                    type: "object",
                                    required: ["id", "email", "expiresAt"],
                                    properties: {
                                        id: { type: "string" },
                                        email: { type: "string", format: "email" },
                                        expiresAt: {
                                            type: "string",
                                            format: "date-time",
                                            description: `${PENDING_REGISTRATION_HOURS} hours after the last accepted \`POST /auth/register\` for the address. A resend doesn't move it.`
                                        }
                                    }
                                }
                            },
                            pagination: {
                                type: "object",
                                required: ["limit", "page", "total", "pages"],
                                properties: {
                                    limit: { type: "integer" },
                                    page: { type: "integer" },
                                    total: { type: "integer" },
                                    pages: {
                                        type: "integer",
                                        description: "`0` when nothing matches."
                                    }
                                }
                            }
                        }
                    },
                    {
                        pendingRegistrations: [
                            {
                                id: "64b7f2e4c3d4e5f60718293a",
                                email: "example@example.com",
                                expiresAt: "2026-01-16T10:00:00.000Z"
                            }
                        ],
                        pagination: { limit: 20, page: 1, total: 1, pages: 1 }
                    }
                ),
                "400": invalidQueryResponse("limit", "page", "q")
            }
        })
    },
    "/admin/pending-registrations/{id}": {
        delete: adminOperation("admin:write", {
            summary: "Remove a pending registration",
            description:
                "Removes a pending registration with its code and its daily wrong-code count, so its code no longer verifies and the address can register again straight away. The in-memory `codeChecksPerEmail` limit stays: clear it with `DELETE /admin/rate-limits`.",
            parameters: [objectIdParameter("The pending registration's ID.")],
            responses: {
                "200": message("Removed.", Responses.Admin.pendingRegistrationRemovedSuccess),
                "400": errorResponse("`id` isn't an ID.", Responses.Database.invalidIdFormat),
                "404": errorResponse(
                    "No such pending registration, e.g. already verified, removed or expired.",
                    Responses.Admin.pendingRegistrationNotFound
                )
            }
        })
    }
};
