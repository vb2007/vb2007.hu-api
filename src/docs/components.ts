import type { OpenAPIV3_1 } from "openapi-types";

import { Responses } from "../constants/responses";
import {
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    JSON_BODY_MAX_BYTES
} from "../constants/limits";
import { sessionCookie } from "../helpers/session";

const errorContent = (errors: string[]): OpenAPIV3_1.ResponseObject["content"] => ({
    "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        examples: Object.fromEntries(
            errors.map((error: string, index: number) => [
                `error${index + 1}`,
                { summary: error, value: { error } }
            ])
        )
    }
});

export const errorResponse = (
    description: string,
    ...errors: string[]
): OpenAPIV3_1.ResponseObject => ({ description, content: errorContent(errors) });

export const rateLimitedResponse = (error: string): OpenAPIV3_1.ResponseObject => ({
    description: "Rate limited: wait `retryAfter` seconds before trying again.",
    headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    content: {
        "application/json": {
            schema: { $ref: "#/components/schemas/RateLimited" },
            example: { error, retryAfter: 60 }
        }
    }
});

export const components: OpenAPIV3_1.ComponentsObject = {
    securitySchemes: {
        session: {
            type: "apiKey",
            in: "cookie",
            name: sessionCookie,
            description:
                "The session cookie set by logging in. An operation that also accepts an API key falls back to the session when no `Authorization` header is sent."
        },
        apiKey: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "vbk_…",
            description:
                "An API key sent as `Authorization: Bearer vbk_…`. Each operation lists the one scope its key needs. Operations without this scheme answer an `Authorization` header with 403."
        }
    },
    schemas: {
        Error: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } }
        },
        RateLimited: {
            type: "object",
            required: ["error", "retryAfter"],
            properties: {
                error: { type: "string" },
                retryAfter: {
                    type: "integer",
                    minimum: 1,
                    description: "Seconds until the limit resets."
                }
            }
        }
    },
    headers: {
        RetryAfter: {
            description: "Seconds until the limit resets.",
            schema: { type: "integer", minimum: 1 }
        }
    },
    responses: {
        InvalidJson: errorResponse(
            "The body isn't valid JSON, or isn't an object or an array.",
            Responses.invalidJson
        ),
        RequestTooLarge: errorResponse(
            `The JSON body is over ${JSON_BODY_MAX_BYTES / 1024} KiB.`,
            Responses.requestTooLarge
        ),
        NotLoggedIn: errorResponse(
            "No session cookie, or the session is unknown or expired.",
            Responses.notLoggedIn
        ),
        NotAuthorized: errorResponse(
            "Logged in, but not allowed to do this.",
            Responses.notAuthorized
        ),
        ApiKeyNotAccepted: errorResponse(
            "An `Authorization` header was sent to an operation that needs a session.",
            Responses.ApiKeys.apiKeyNotAccepted
        ),
        InvalidApiKey: {
            ...errorResponse(
                "The API key is malformed, unknown, expired or revoked.",
                Responses.ApiKeys.invalidApiKey
            ),
            headers: {
                "WWW-Authenticate": {
                    description: 'Always `Bearer realm="vb2007.hu", error="invalid_token"`.',
                    schema: { type: "string" }
                }
            }
        },
        ApiKeyRateLimited: {
            ...rateLimitedResponse(Responses.tooManyFailedAttempts),
            description: `Over ${FAILED_ATTEMPTS_PER_IP} rejected API keys from this IP address in ${FAILED_ATTEMPTS_WINDOW_MS / 60000} minutes.`
        },
        ServerError: errorResponse("An unexpected server error.", Responses.internalServerError)
    }
};
