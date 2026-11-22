import multer from "multer";

import type { DocsModule } from "../openapi";
import { apiKeyForbiddenResponse, errorResponse } from "../components";
import { Responses } from "../../constants/responses";
import { ALLOWED_UPLOAD_TYPES, UPLOAD_CATEGORIES } from "../../constants/uploads";
import {
    LIST_MAX_LIMIT,
    LIST_QUERY_MAX_LENGTH,
    UPLOAD_FILE_NAME_MAX_LENGTH,
    UPLOAD_FILE_NAME_MIN_LENGTH,
    UPLOAD_MULTIPART_OVERHEAD_BYTES,
    UPLOAD_URL_TTL_SECONDS
} from "../../constants/limits";
import { sortOrders, uploadSortFields, uploadVisibilities } from "../../database/userUploads";
import { fileTooLargeError, maxFileSizeBytes, uploadTooLargeError } from "../../helpers/multer";
import { defaultUploadQuotaBytes } from "../../helpers/uploadQuota";

const tag: string = "uploads";

const readSecurity = [{ session: [] as string[] }, { apiKey: ["uploads:read"] }];

const writeSecurity = [{ session: [] as string[] }, { apiKey: ["uploads:write"] }];

const uploadRef = { $ref: "#/components/schemas/Upload" };

const exampleUpload = {
    id: "6b033f6a9ebe0cbc91f9d5fe",
    originalFileName: "notes.txt",
    extension: ".txt",
    mimeType: "text/plain",
    fileSize: 11,
    visibility: "private",
    url: "https://cdn.vb2007.hu/useruploads/6b033f6a9ebe0cbc91f9d5fd/6b033f6a9ebe0cbc91f9d5fe.txt?expires=1795378554&sig=hD1it_L4jb4G0nLJbu0iVGTU9Eb4VwZdnuDBejWdMPs",
    uploadedOn: "2026-11-22T19:15:54.713Z",
    updatedOn: "2026-11-22T19:15:54.713Z"
};

const uploadIdParameter = {
    name: "id",
    in: "path",
    required: true,
    description: "The upload's ID.",
    schema: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
    example: exampleUpload.id
};

const apiKeyAnswers = {
    "401": { $ref: "#/components/responses/InvalidApiKey" },
    "429": { $ref: "#/components/responses/ApiKeyRateLimited" },
    "500": { $ref: "#/components/responses/ServerError" }
};

const ownerAnswers = (scope: string) => ({
    "400": errorResponse("The ID isn't 24 hex characters.", Responses.Database.invalidIdFormat),
    "403": apiKeyForbiddenResponse(scope, Responses.notAuthorized),
    "404": errorResponse("There is no upload with this ID.", Responses.UserUploads.uploadNotFound)
});

const ownerCheck: string =
    "Only the upload's owner may do this; the superuser passes too (with an API key, only one that also has `admin:write`). Anyone else gets `403`.";

const multipartErrors: string[] = [
    "LIMIT_FIELD_COUNT",
    "LIMIT_FILE_COUNT",
    "LIMIT_UNEXPECTED_FILE",
    "MISSING_FIELD_NAME",
    "LIMIT_FIELD_VALUE"
].map((code: string): string => new multer.MulterError(code as multer.ErrorCode).message);

const multipartParserErrors: string[] = [
    "Malformed part header",
    "Unexpected end of form",
    "Multipart: Boundary not found"
];

const maxFileSizeMb: number = maxFileSizeBytes / 1024 / 1024;

const forbiddenText = {
    "text/plain": { schema: { type: "string", const: "Forbidden" } }
};

export const tags: DocsModule["tags"] = [
    {
        name: tag,
        description: `File uploads, served from the cdn. Public uploads are served at their plain URL, private ones only at a signed URL that works for ${UPLOAD_URL_TTL_SECONDS / 60} minutes.`
    }
];

export const components: DocsModule["components"] = {
    schemas: {
        Upload: {
            type: "object",
            required: [
                "id",
                "originalFileName",
                "extension",
                "mimeType",
                "fileSize",
                "visibility",
                "url",
                "uploadedOn",
                "updatedOn"
            ],
            properties: {
                id: { type: "string", pattern: "^[0-9a-f]{24}$" },
                originalFileName: { type: "string" },
                extension: {
                    type: "string",
                    enum: ALLOWED_UPLOAD_TYPES.map(({ extension }) => extension),
                    description: "Set from the detected type, not from the file name."
                },
                mimeType: {
                    type: "string",
                    description: "The detected type, one of `allowedTypes` in the usage."
                },
                fileSize: { type: "integer", minimum: 0, description: "In bytes." },
                visibility: { type: "string", enum: [...uploadVisibilities] },
                url: {
                    type: "string",
                    format: "uri",
                    description: `The file on the cdn: the plain URL for a public upload, a URL signed for ${UPLOAD_URL_TTL_SECONDS / 60} minutes (\`?expires=<unix seconds>&sig=…\`) for a private one. A signed URL can't be revoked before it expires except by deleting the upload.`
                },
                uploadedOn: { type: ["string", "null"], format: "date-time" },
                updatedOn: { type: ["string", "null"], format: "date-time" }
            },
            example: exampleUpload
        },
        UploadUsage: {
            type: "object",
            required: [
                "usedBytes",
                "quotaBytes",
                "count",
                "maxFileSizeBytes",
                "allowedTypes",
                "byCategory"
            ],
            properties: {
                usedBytes: { type: "integer", minimum: 0 },
                quotaBytes: {
                    type: "integer",
                    minimum: 0,
                    description: `The account's storage quota: ${defaultUploadQuotaBytes} bytes unless the superuser set another one.`
                },
                count: { type: "integer", minimum: 0, description: "The number of uploads." },
                maxFileSizeBytes: { type: "integer", minimum: 1, const: maxFileSizeBytes },
                allowedTypes: {
                    type: "array",
                    items: {
                        type: "object",
                        required: ["mimeType", "extension", "category"],
                        properties: {
                            mimeType: { type: "string" },
                            extension: { type: "string" },
                            category: { type: "string", enum: [...UPLOAD_CATEGORIES] }
                        }
                    }
                },
                byCategory: {
                    type: "array",
                    description: "One entry per category, in this order, zero when empty.",
                    items: {
                        type: "object",
                        required: ["category", "bytes", "count"],
                        properties: {
                            category: { type: "string", enum: [...UPLOAD_CATEGORIES] },
                            bytes: { type: "integer", minimum: 0 },
                            count: { type: "integer", minimum: 0 }
                        }
                    }
                }
            },
            example: {
                usedBytes: 11,
                quotaBytes: defaultUploadQuotaBytes,
                count: 1,
                maxFileSizeBytes,
                allowedTypes: ALLOWED_UPLOAD_TYPES,
                byCategory: UPLOAD_CATEGORIES.map((category) => ({
                    category,
                    bytes: category === "document" ? 11 : 0,
                    count: category === "document" ? 1 : 0
                }))
            }
        },
        UploadList: {
            type: "object",
            required: ["uploads", "pagination"],
            properties: {
                uploads: { type: "array", items: uploadRef },
                pagination: {
                    type: "object",
                    required: ["limit", "page", "total", "pages", "sortBy", "sortOrder"],
                    properties: {
                        limit: { type: "integer" },
                        page: { type: "integer" },
                        total: {
                            type: "integer",
                            description: "Uploads matching the filters, on every page."
                        },
                        pages: { type: "integer" },
                        sortBy: { type: "string", enum: [...uploadSortFields] },
                        sortOrder: { type: "string", enum: [...sortOrders] }
                    }
                }
            },
            example: {
                uploads: [exampleUpload],
                pagination: {
                    limit: 20,
                    page: 1,
                    total: 1,
                    pages: 1,
                    sortBy: "uploadedOn",
                    sortOrder: "desc"
                }
            }
        },
        UploadAnswer: {
            type: "object",
            required: ["message", "upload"],
            properties: { message: { type: "string" }, upload: uploadRef }
        }
    }
};

const uploadAnswer = (description: string, message: string) => ({
    description,
    content: {
        "application/json": {
            schema: { $ref: "#/components/schemas/UploadAnswer" },
            example: { message, upload: exampleUpload }
        }
    }
});

const listParameter = (name: string, description: string, schema: object) => ({
    name,
    in: "query",
    required: false,
    description: `${description} Given more than once, or invalid, it answers \`400\`.`,
    schema
});

export const paths: DocsModule["paths"] = {
    "/uploads/access": {
        get: {
            tags: [tag],
            summary: "Check access to an upload's file",
            description:
                "Used by the cdn's nginx (`auth_request`) on every request for a file under `/useruploads/`, to ask whether it may be served. A public upload is allowed at its plain URL, with any query string. A private one only at a signed URL that hasn't expired. The answer has no JSON body.",
            security: [],
            parameters: [
                {
                    name: "X-Original-URI",
                    in: "header",
                    required: false,
                    description:
                        "The requested path and query on the cdn: `/useruploads/<userId>/<uploadId><ext>`, plus `?expires=<unix seconds>&sig=<signature>` for a private upload.",
                    schema: { type: "string" },
                    example: exampleUpload.url.replace("https://cdn.vb2007.hu", "")
                }
            ],
            responses: {
                "204": {
                    description: "The file may be served.",
                    headers: {
                        "X-Upload-Visibility": {
                            description: "The upload's visibility.",
                            schema: { type: "string", enum: [...uploadVisibilities] }
                        },
                        "X-Upload-Filename": {
                            description:
                                "The upload's file name, RFC 5987 encoded for `Content-Disposition`, e.g. `UTF-8''notes.txt`.",
                            schema: { type: "string" }
                        }
                    }
                },
                "403": {
                    description:
                        "The file may not be served: the header is missing or isn't an upload's path, there's no such upload in that folder with that extension, or the upload is private and the URL isn't signed, is signed for another path or has expired.",
                    content: forbiddenText
                },
                "500": { $ref: "#/components/responses/ServerError" }
            }
        }
    },
    "/uploads/usage": {
        get: {
            tags: [tag],
            summary: "Get storage usage",
            description:
                "Returns how much of their storage quota the caller's uploads use, by category, with the file size limit and the allowed file types.",
            security: readSecurity,
            responses: {
                "200": {
                    description: "The caller's usage.",
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/UploadUsage" }
                        }
                    }
                },
                "403": apiKeyForbiddenResponse("uploads:read"),
                ...apiKeyAnswers
            }
        }
    },
    "/uploads": {
        get: {
            tags: [tag],
            summary: "List own uploads",
            description:
                "Lists the caller's uploads, a page at a time, optionally filtered by visibility and file name.",
            security: readSecurity,
            parameters: [
                listParameter("limit", "Uploads per page.", {
                    type: "integer",
                    minimum: 1,
                    maximum: LIST_MAX_LIMIT,
                    default: 20
                }),
                listParameter("page", "The page, from 1. A page past the last one is empty.", {
                    type: "integer",
                    minimum: 1,
                    maximum: Number.MAX_SAFE_INTEGER,
                    default: 1
                }),
                listParameter(
                    "sortBy",
                    "The sort field. `originalFileName` sorts case-insensitively.",
                    { type: "string", enum: [...uploadSortFields], default: "uploadedOn" }
                ),
                listParameter("sortOrder", "The sort direction.", {
                    type: "string",
                    enum: [...sortOrders],
                    default: "desc"
                }),
                listParameter("visibility", "Only uploads with this visibility.", {
                    type: "string",
                    enum: [...uploadVisibilities]
                }),
                listParameter(
                    "q",
                    "Only uploads whose file name contains this text, case-insensitively and literally.",
                    { type: "string", maxLength: LIST_QUERY_MAX_LENGTH }
                )
            ],
            responses: {
                "200": {
                    description: "A page of the caller's uploads.",
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/UploadList" }
                        }
                    }
                },
                "400": errorResponse(
                    "A query parameter is invalid or given more than once; the first one found is named.",
                    ...["limit", "page", "sortBy", "sortOrder", "visibility", "q"].map(
                        Responses.invalidQuery
                    )
                ),
                "403": apiKeyForbiddenResponse("uploads:read"),
                ...apiKeyAnswers
            }
        }
    },
    "/upload/{id}": {
        get: {
            tags: [tag],
            summary: "Get an upload",
            description: `Returns an upload, with a freshly signed URL when it's private. ${ownerCheck}`,
            security: readSecurity,
            parameters: [uploadIdParameter],
            responses: {
                "200": {
                    description: "The upload.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["upload"],
                                properties: { upload: uploadRef }
                            },
                            example: { upload: exampleUpload }
                        }
                    }
                },
                ...ownerAnswers("uploads:read"),
                ...apiKeyAnswers
            }
        },
        patch: {
            tags: [tag],
            summary: "Rename an upload or change its visibility",
            description: `Changes the upload's file name, its visibility or both. The file and its path stay the same. Making an upload private stops its plain URL at once; making it public makes the file reachable by anyone. ${ownerCheck}`,
            security: writeSecurity,
            parameters: [uploadIdParameter],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            minProperties: 1,
                            properties: {
                                originalFileName: {
                                    type: "string",
                                    minLength: UPLOAD_FILE_NAME_MIN_LENGTH,
                                    maxLength: UPLOAD_FILE_NAME_MAX_LENGTH,
                                    description:
                                        "The new file name, trimmed first. No slashes or control characters."
                                },
                                visibility: { type: "string", enum: [...uploadVisibilities] }
                            }
                        },
                        example: { originalFileName: "notes.txt", visibility: "public" }
                    }
                }
            },
            responses: {
                "200": uploadAnswer(
                    "Updated: the upload as it is now.",
                    Responses.UserUploads.uploadUpdatedSuccess
                ),
                ...ownerAnswers("uploads:write"),
                "400": errorResponse(
                    "The ID, the body or a field is invalid, or neither field was sent (also for no body or a body that isn't JSON).",
                    Responses.Database.invalidIdFormat,
                    Responses.invalidJson,
                    Responses.UserUploads.nothingToUpdate,
                    Responses.UserUploads.invalidFileName,
                    Responses.UserUploads.invalidVisibility
                ),
                "413": { $ref: "#/components/responses/RequestTooLarge" },
                ...apiKeyAnswers
            }
        },
        delete: {
            tags: [tag],
            summary: "Delete an upload",
            description: `Deletes the upload and its file. Its URLs, signed ones too, stop working at once. ${ownerCheck}`,
            security: writeSecurity,
            parameters: [uploadIdParameter],
            responses: {
                "200": {
                    description: "Deleted.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["message", "upload"],
                                properties: {
                                    message: { type: "string" },
                                    upload: {
                                        type: "object",
                                        required: ["id"],
                                        properties: { id: { type: "string" } }
                                    }
                                }
                            },
                            example: {
                                message: Responses.UserUploads.uploadDeletedSuccess,
                                upload: { id: exampleUpload.id }
                            }
                        }
                    }
                },
                ...ownerAnswers("uploads:write"),
                ...apiKeyAnswers
            }
        }
    },
    "/upload": {
        post: {
            tags: [tag],
            summary: "Upload a file",
            description: `Stores one file for the caller. Its type is detected from its content, and \`.txt\`, \`.md\`, \`.csv\` and \`.json\` files (which have no signature) from their name's extension, as long as they are valid UTF-8 without NUL bytes (and valid JSON for \`.json\`); the stored extension follows the detected type. The upload's \`originalFileName\` is the file part's file name without its path.\n\nThe login check comes first, then the size: a \`Content-Length\` over ${maxFileSizeMb} MB plus ${UPLOAD_MULTIPART_OVERHEAD_BYTES / 1024} KiB for the multipart framing answers \`413\` at once, and so does a streamed body once it passes that size or its file passes ${maxFileSizeMb} MB. An answer sent before the body has fully arrived closes the connection (\`Connection: close\`). With \`Expect: 100-continue\`, \`100 Continue\` is only sent once the body is read, so a refused upload never sends it.`,
            security: writeSecurity,
            requestBody: {
                required: true,
                content: {
                    "multipart/form-data": {
                        schema: {
                            type: "object",
                            required: ["file"],
                            properties: {
                                file: {
                                    type: "string",
                                    contentMediaType: "application/octet-stream",
                                    description: `The file, up to ${maxFileSizeBytes} bytes. Only one, under this name. A part without a file name counts as no file.`
                                },
                                visibility: {
                                    type: "string",
                                    enum: [...uploadVisibilities],
                                    default: "private",
                                    description:
                                        "The only other field the upload reads. At most one field besides the file is allowed, up to 1 MB."
                                }
                            }
                        },
                        encoding: { file: { contentType: "application/octet-stream" } }
                    }
                }
            },
            responses: {
                "201": uploadAnswer("Stored: the new upload.", Responses.UserUploads.uploadSuccess),
                "400": errorResponse(
                    "No file, an invalid visibility, or a malformed or over-limit multipart body (the multipart parser's own messages), or a body sent as invalid JSON.",
                    Responses.UserUploads.noFileProvided,
                    Responses.UserUploads.invalidVisibility,
                    ...multipartErrors,
                    ...multipartParserErrors,
                    Responses.invalidJson
                ),
                "403": apiKeyForbiddenResponse("uploads:write"),
                "413": errorResponse(
                    "The request or its file is over the size limit, the file would take the caller over their storage quota, or a JSON body is over its limit.",
                    uploadTooLargeError,
                    fileTooLargeError,
                    Responses.UserUploads.quotaExceeded,
                    Responses.requestTooLarge
                ),
                "415": errorResponse(
                    "The file's type isn't one of the allowed types (see the usage's `allowedTypes`).",
                    Responses.UserUploads.unsupportedFileType
                ),
                ...apiKeyAnswers
            }
        }
    }
};
