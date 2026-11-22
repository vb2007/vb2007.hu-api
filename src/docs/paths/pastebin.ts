import type { DocsModule } from "../openapi";
import {
    apiKeyForbiddenResponse,
    apiKeyResponses,
    badRequest,
    errorResponse,
    listQueryParameter,
    objectId,
    objectIdParameter,
    requestTooLarge
} from "../components";
import { Responses } from "../../constants/responses";
import {
    LIST_MAX_LIMIT,
    PASTE_MAX_LENGTH,
    PASTE_MIN_LENGTH,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH
} from "../../constants/limits";
import { pasteLanguagePattern, pasteSortFields } from "../../database/pastebin";
import { sortOrders } from "../../database/userUploads";

const pasteId = "6b033f4d6d663d6c5ab9b1d3";
const ownerId = "6b033f4d6d663d6c5ab9b1d1";
const addedOn = "2026-11-22T19:15:25.234Z";

const language = { type: "string", pattern: pasteLanguagePattern.source };

const pasteProperties = {
    _id: objectId,
    content: {
        type: "string",
        minLength: PASTE_MIN_LENGTH,
        maxLength: PASTE_MAX_LENGTH
    },
    language: {
        ...language,
        description: "The paste's language, e.g. `ts` or `c++`. Left out when the paste has none."
    },
    addedOn: { type: "string", format: "date-time" }
};

const ownerCheck =
    "Only the paste's owner may do this. The superuser passes the owner check too (with an API key, only one that also has the `admin:write` scope).";

const idParameter = objectIdParameter("The paste's ID.");

const invalidPath = errorResponse(
    "The ID isn't a 24 character hex string, or the path has a malformed percent-encoding.",
    Responses.Database.invalidIdFormat,
    badRequest
);

const notFound = errorResponse("There is no paste with that ID.", Responses.Pastebin.pasteNotFound);

const savedPasteSchema = { $ref: "#/components/schemas/PasteSaved" };

const savedPaste = (message: string, language: string, paste: object = savedPasteSchema) => ({
    "application/json": {
        schema: {
            type: "object",
            required: ["message", "paste"],
            properties: {
                message: { type: "string", const: message },
                paste
            }
        },
        example: {
            message,
            paste: {
                _id: pasteId,
                content: "console.log(1);",
                language,
                addedBy: ownerId,
                addedOn
            }
        }
    }
});

export const tags: DocsModule["tags"] = [
    {
        name: "pastes",
        description:
            "Text pastes. Anyone with a paste's ID can read it: pastes have no private visibility."
    }
];

export const components: DocsModule["components"] = {
    schemas: {
        PasteOwner: {
            type: ["object", "null"],
            required: ["_id", "username"],
            description: "Who added the paste, or `null` if that account is gone.",
            properties: { _id: objectId, username: { type: "string" } }
        },
        Paste: {
            type: "object",
            required: ["_id", "content", "addedBy", "addedOn"],
            properties: {
                ...pasteProperties,
                addedBy: { $ref: "#/components/schemas/PasteOwner" }
            }
        },
        PasteSaved: {
            type: "object",
            required: ["_id", "content", "addedBy", "addedOn"],
            description: "A paste as saved: `addedBy` is only the owner's ID.",
            properties: { ...pasteProperties, addedBy: objectId }
        },
        PastePagination: {
            type: "object",
            required: ["limit", "page", "total", "pages", "sortBy", "sortOrder"],
            properties: {
                limit: { type: "integer" },
                page: { type: "integer" },
                total: { type: "integer", description: "The user's pastes in all." },
                pages: { type: "integer" },
                sortBy: { type: "string", enum: [...pasteSortFields] },
                sortOrder: { type: "string", enum: [...sortOrders] }
            }
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/pastes/{username}": {
        get: {
            tags: ["pastes"],
            summary: "List a user's pastes",
            description:
                "Lists any user's pastes, a page at a time, with their full content. The query is checked before the username.",
            security: [{ session: [] }, { apiKey: ["pastes:read"] }],
            parameters: [
                {
                    name: "username",
                    in: "path",
                    required: true,
                    description:
                        "The user's name, compared like usernames are (case doesn't matter), but not trimmed.",
                    schema: {
                        type: "string",
                        minLength: USERNAME_MIN_LENGTH,
                        maxLength: USERNAME_MAX_LENGTH
                    }
                },
                listQueryParameter("limit", "Pastes per page.", {
                    type: "integer",
                    minimum: 1,
                    maximum: LIST_MAX_LIMIT,
                    default: 10
                }),
                listQueryParameter("page", "The page, from 1.", {
                    type: "integer",
                    minimum: 1,
                    default: 1
                }),
                listQueryParameter("sortBy", "The field to sort by.", {
                    type: "string",
                    enum: [...pasteSortFields],
                    default: "addedOn"
                }),
                listQueryParameter("sortOrder", "The sort direction.", {
                    type: "string",
                    enum: [...sortOrders],
                    default: "desc"
                })
            ],
            responses: {
                "200": {
                    description: "A page of the user's pastes.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["pastes", "pagination"],
                                properties: {
                                    pastes: {
                                        type: "array",
                                        items: { $ref: "#/components/schemas/Paste" }
                                    },
                                    pagination: { $ref: "#/components/schemas/PastePagination" }
                                }
                            },
                            example: {
                                pastes: [
                                    {
                                        _id: pasteId,
                                        content: "console.log(1);",
                                        language: "ts",
                                        addedBy: { _id: ownerId, username: "alice" },
                                        addedOn
                                    }
                                ],
                                pagination: {
                                    limit: 10,
                                    page: 1,
                                    total: 1,
                                    pages: 1,
                                    sortBy: "addedOn",
                                    sortOrder: "desc"
                                }
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "A query parameter has an invalid value, or the path has a malformed percent-encoding.",
                    ...["limit", "page", "sortBy", "sortOrder"].map(Responses.invalidQuery),
                    badRequest
                ),
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse("pastes:read"),
                "404": errorResponse(
                    "No user has that name, or it isn't a valid username (too short, too long or with characters usernames can't have): an invalid name answers `404`, not `400`.",
                    Responses.Pastebin.noSuchUser
                ),
                "429": apiKeyResponses["429"],
                "500": apiKeyResponses["500"]
            }
        }
    },
    "/paste/{id}": {
        get: {
            tags: ["pastes"],
            summary: "Get a paste",
            description: "Returns a paste and who added it. Anyone with the ID can read it.",
            security: [],
            parameters: [idParameter],
            responses: {
                "200": {
                    description: "The paste.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["paste"],
                                properties: { paste: { $ref: "#/components/schemas/Paste" } }
                            },
                            example: {
                                paste: {
                                    _id: pasteId,
                                    content: "console.log(1);",
                                    language: "ts",
                                    addedBy: { _id: ownerId, username: "alice" },
                                    addedOn
                                }
                            }
                        }
                    }
                },
                "400": invalidPath,
                "404": notFound,
                "500": apiKeyResponses["500"]
            }
        },
        patch: {
            tags: ["pastes"],
            summary: "Change a paste's language",
            description: `Sets the paste's language. The content can't be changed. ${ownerCheck}`,
            security: [{ session: [] }, { apiKey: ["pastes:write"] }],
            parameters: [idParameter],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["language"],
                            properties: { language }
                        },
                        example: { language: "js" }
                    }
                }
            },
            responses: {
                "200": {
                    description:
                        "The language is changed. `paste` is `null` if the paste was deleted meanwhile.",
                    content: savedPaste(Responses.Pastebin.pasteUpdatedSuccess, "js", {
                        oneOf: [savedPasteSchema, { type: "null" }]
                    })
                },
                "400": errorResponse(
                    "The ID isn't a 24 character hex string, the body isn't valid JSON, `language` is missing or invalid, or the path has a malformed percent-encoding.",
                    Responses.Database.invalidIdFormat,
                    Responses.invalidJson,
                    Responses.Pastebin.invalidLanguage,
                    badRequest
                ),
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse("pastes:write", Responses.notAuthorized),
                "404": notFound,
                "413": requestTooLarge,
                "429": apiKeyResponses["429"],
                "500": apiKeyResponses["500"]
            }
        },
        delete: {
            tags: ["pastes"],
            summary: "Delete a paste",
            description: `Deletes the paste. ${ownerCheck}`,
            security: [{ session: [] }, { apiKey: ["pastes:write"] }],
            parameters: [idParameter],
            responses: {
                "200": {
                    description: "The paste is deleted. Note the ID's key is `id` here.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["message", "paste"],
                                properties: {
                                    message: {
                                        type: "string",
                                        const: Responses.Pastebin.pasteDeletedSuccess
                                    },
                                    paste: {
                                        type: "object",
                                        required: ["id"],
                                        properties: { id: objectId }
                                    }
                                }
                            },
                            example: {
                                message: Responses.Pastebin.pasteDeletedSuccess,
                                paste: { id: pasteId }
                            }
                        }
                    }
                },
                "400": invalidPath,
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse("pastes:write", Responses.notAuthorized),
                "404": notFound,
                "429": apiKeyResponses["429"],
                "500": apiKeyResponses["500"]
            }
        }
    },
    "/paste": {
        post: {
            tags: ["pastes"],
            summary: "Create a paste",
            description:
                "Saves a paste for the logged-in user. A body that isn't JSON counts as missing content.",
            security: [{ session: [] }, { apiKey: ["pastes:write"] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["paste"],
                            properties: {
                                paste: {
                                    ...pasteProperties.content,
                                    description:
                                        "The content, its length counted in UTF-16 code units."
                                },
                                language: { ...language, description: "Optional; can't be `null`." }
                            }
                        },
                        example: { paste: "console.log(1);", language: "ts" }
                    }
                }
            },
            responses: {
                "201": {
                    description: "The paste is saved.",
                    content: savedPaste(Responses.Pastebin.pasteCreatedSuccess, "ts")
                },
                "400": errorResponse(
                    "The body isn't valid JSON, `paste` is missing, empty, not a string or too short or long, or `language` is invalid.",
                    Responses.invalidJson,
                    Responses.Pastebin.missingPaste,
                    Responses.Pastebin.invalidPasteLength,
                    Responses.Pastebin.invalidLanguage
                ),
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse("pastes:write"),
                "413": requestTooLarge,
                "429": apiKeyResponses["429"],
                "500": apiKeyResponses["500"]
            }
        }
    }
};
