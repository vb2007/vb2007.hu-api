import type { DocsModule } from "../openapi";
import {
    apiKeyForbiddenResponse,
    apiKeyResponses,
    badRequest,
    errorResponse,
    listQueryParameter,
    objectId,
    serverError
} from "../components";
import { Responses } from "../../constants/responses";
import {
    LIST_MAX_LIMIT,
    LIST_QUERY_MAX_LENGTH,
    SHORT_URL_CODE_LENGTH,
    SHORT_URL_MAX_LENGTH,
    SHORT_URLS_PER_USER_MAX
} from "../../constants/limits";
import { shortUrlSortFields } from "../../database/shortUrls";
import { sortOrders } from "../../database/userUploads";
import { validURIType } from "../../helpers/text";

const ownerId = "6b033f4d6d663d6c5ab9b1d1";
const shortenedUrl = "YFRMYi";
const originalUrl = "https://example.com/some/long/path";
const addedOn = "2026-11-22T19:15:25.357Z";

const code = {
    type: "string",
    description: `The short code: ${SHORT_URL_CODE_LENGTH} letters and digits, case-sensitive.`
};

const date = {
    type: ["string", "null"],
    format: "date-time",
    description: "When the link was made; `null` on some old links."
};

const codeParameter = {
    name: "shortenedUrl",
    in: "path",
    required: true,
    description: "The short code, e.g. `YFRMYi`.",
    schema: { type: "string" }
};

const notFound = errorResponse("No short link has that code.", Responses.ShortenUrl.urlNotFound);

const malformedPath = errorResponse("The path has a malformed percent-encoding.", badRequest);

const shortened = (message: string) => ({
    "application/json": {
        schema: {
            type: "object",
            required: ["message", "data"],
            properties: {
                message: { type: "string", const: message },
                data: { $ref: "#/components/schemas/ShortUrlSaved" }
            }
        },
        example: { message, data: { shortenedUrl, originalUrl, addedOn, addedBy: ownerId } }
    }
});

export const tags: DocsModule["tags"] = [
    { name: "Short URLs", description: "Short links that redirect to a saved URL." }
];

export const components: DocsModule["components"] = {
    schemas: {
        ShortUrlSaved: {
            type: "object",
            required: ["shortenedUrl", "originalUrl", "addedOn", "addedBy"],
            properties: {
                shortenedUrl: code,
                originalUrl: { type: "string" },
                addedOn: date,
                addedBy: { ...objectId, description: "The owner's ID." }
            }
        },
        ShortUrlListItem: {
            type: "object",
            required: ["shortenedUrl", "originalUrl"],
            properties: {
                shortenedUrl: code,
                originalUrl: { type: "string" },
                addedOn: {
                    ...date,
                    description: "When the link was made; `null` or left out on some old links."
                }
            }
        },
        ShortUrlPagination: {
            type: "object",
            required: ["limit", "page", "total", "pages", "sortBy", "sortOrder"],
            properties: {
                limit: { type: "integer" },
                page: { type: "integer" },
                total: { type: "integer", description: "The matching links in all." },
                pages: { type: "integer" },
                sortBy: { type: "string", enum: [...shortUrlSortFields] },
                sortOrder: { type: "string", enum: [...sortOrders] }
            }
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/r/{shortenedUrl}": {
        get: {
            tags: ["Short URLs"],
            summary: "Follow a short link",
            description: "Redirects to the link's original URL.",
            security: [],
            parameters: [codeParameter],
            responses: {
                "302": {
                    description:
                        "Redirect to the original URL. The body follows `Accept`: plain text, HTML with the URL HTML-escaped, or empty when neither is accepted.",
                    headers: {
                        Location: {
                            description:
                                "The stored URL, percent-encoded by Express where it isn't URL-safe (`é` becomes `%C3%A9`).",
                            schema: { type: "string" }
                        }
                    },
                    content: {
                        "text/plain": {
                            schema: { type: "string" },
                            example: `Found. Redirecting to ${originalUrl}`
                        },
                        "text/html": {
                            schema: { type: "string" },
                            example: `<p>Found. Redirecting to ${originalUrl}</p>`
                        }
                    }
                },
                "400": malformedPath,
                "404": notFound,
                "500": serverError
            }
        }
    },
    "/shortenUrls": {
        get: {
            tags: ["Short URLs"],
            summary: "List own short links",
            description: "Lists the logged-in user's own short links, a page at a time.",
            security: [{ session: [] }, { apiKey: ["shortUrls:read"] }],
            parameters: [
                listQueryParameter("limit", "Links per page.", {
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
                    enum: [...shortUrlSortFields],
                    default: "addedOn"
                }),
                listQueryParameter("sortOrder", "The sort direction.", {
                    type: "string",
                    enum: [...sortOrders],
                    default: "desc"
                }),
                listQueryParameter(
                    "q",
                    "Only links whose code or original URL contains this text, matched literally and case-insensitively. No NUL characters.",
                    { type: "string", maxLength: LIST_QUERY_MAX_LENGTH }
                )
            ],
            responses: {
                "200": {
                    description: "A page of the user's short links.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["shortUrls", "pagination"],
                                properties: {
                                    shortUrls: {
                                        type: "array",
                                        items: { $ref: "#/components/schemas/ShortUrlListItem" }
                                    },
                                    pagination: {
                                        $ref: "#/components/schemas/ShortUrlPagination"
                                    }
                                }
                            },
                            example: {
                                shortUrls: [{ originalUrl, shortenedUrl, addedOn }],
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
                    "A query parameter has an invalid value.",
                    ...["limit", "page", "sortBy", "sortOrder", "q"].map(Responses.invalidQuery)
                ),
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse("shortUrls:read"),
                "429": apiKeyResponses["429"],
                "500": serverError
            }
        }
    },
    "/shortenUrl/{shortenedUrl}": {
        get: {
            tags: ["Short URLs"],
            summary: "Look up a short link",
            description:
                "Returns a short link's original URL and who made it, without redirecting.",
            security: [],
            parameters: [codeParameter],
            responses: {
                "200": {
                    description: "The short link.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["originalUrl", "addedBy", "addedOn"],
                                properties: {
                                    originalUrl: { type: "string" },
                                    addedBy: {
                                        type: ["object", "null"],
                                        required: ["_id", "username", "createdAt"],
                                        description:
                                            "Who made the link, or `null` if that account is gone.",
                                        properties: {
                                            _id: objectId,
                                            username: { type: "string" },
                                            createdAt: {
                                                type: "string",
                                                format: "date-time",
                                                description: "When the account was made."
                                            }
                                        }
                                    },
                                    addedOn: date
                                }
                            },
                            example: {
                                originalUrl,
                                addedBy: {
                                    _id: ownerId,
                                    username: "alice",
                                    createdAt: "2026-11-22T19:15:25.063Z"
                                },
                                addedOn
                            }
                        }
                    }
                },
                "400": malformedPath,
                "404": notFound,
                "500": serverError
            }
        },
        delete: {
            tags: ["Short URLs"],
            summary: "Delete a short link",
            description:
                "Deletes the short link. Only its owner may do this. The superuser passes the owner check too (with an API key, only one that also has the `admin:write` scope).",
            security: [{ session: [] }, { apiKey: ["shortUrls:write"] }],
            parameters: [codeParameter],
            responses: {
                "200": {
                    description: "The short link is deleted.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["message"],
                                properties: {
                                    message: {
                                        type: "string",
                                        const: Responses.ShortenUrl.urlDeletedSuccess
                                    }
                                }
                            },
                            example: { message: Responses.ShortenUrl.urlDeletedSuccess }
                        }
                    }
                },
                "400": malformedPath,
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse(
                    "shortUrls:write",
                    Responses.ShortenUrl.notAuthorizedToDelete
                ),
                "404": notFound,
                "429": apiKeyResponses["429"],
                "500": serverError
            }
        }
    },
    "/shortenUrl": {
        post: {
            tags: ["Short URLs"],
            summary: "Shorten a URL",
            description: `Makes a short link for the logged-in user. A user gets one link per URL: shortening the same URL again answers \`200\` with the existing link. A user can have at most ${SHORT_URLS_PER_USER_MAX} links, made with a session or an API key alike; at the cap, a URL the user already shortened still answers \`200\` with its link. Parallel requests can pass the cap by a few links. A body that isn't JSON counts as an invalid URL.`,
            security: [{ session: [] }, { apiKey: ["shortUrls:write"] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["url"],
                            properties: {
                                url: {
                                    type: "string",
                                    maxLength: SHORT_URL_MAX_LENGTH,
                                    description: `The URL to shorten, with no whitespace. It must start with one of these (in any case): ${validURIType.map((scheme: string): string => `\`${scheme}\``).join(", ")}. Its scheme is checked before its length.`
                                }
                            }
                        },
                        example: { url: originalUrl }
                    }
                }
            },
            responses: {
                "200": {
                    description: "The user already shortened this URL: its existing link.",
                    content: shortened(Responses.ShortenUrl.alreadyShortened)
                },
                "201": {
                    description: "The short link is made.",
                    content: shortened(Responses.ShortenUrl.urlShortenedSuccess)
                },
                "400": errorResponse(
                    "The body isn't valid JSON, or `url` is missing, not a string, has an unsupported scheme or whitespace, or is too long.",
                    Responses.invalidJson,
                    Responses.ShortenUrl.invalidUrl,
                    Responses.ShortenUrl.urlTooLong
                ),
                "401": apiKeyResponses["401"],
                "403": apiKeyForbiddenResponse("shortUrls:write"),
                "409": errorResponse(
                    `The user already has ${SHORT_URLS_PER_USER_MAX} short links.`,
                    Responses.ShortenUrl.tooManyShortUrls
                ),
                "413": { $ref: "#/components/responses/RequestTooLarge" },
                "429": apiKeyResponses["429"],
                "500": serverError
            }
        }
    }
};
