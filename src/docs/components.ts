import { Responses } from "../constants/responses";
import {
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    JSON_BODY_MAX_BYTES
} from "../constants/limits";
import { sessionCookie } from "../helpers/session";

export type ErrorExample = string | { error: string; [field: string]: unknown };

const exampleOf = (error: ErrorExample): { error: string } =>
    typeof error === "string" ? { error } : error;

const errorContent = (schema: string, examples: { error: string }[]) => ({
    "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
        examples: Object.fromEntries(
            examples.map((value: { error: string }, index: number) => [
                `error${index + 1}`,
                { summary: value.error, value }
            ])
        )
    }
});

export const errorResponse = (description: string, ...errors: ErrorExample[]) => ({
    description,
    content: errorContent("Error", errors.map(exampleOf))
});

export const rateLimitedResponse = (description: string, ...errors: ErrorExample[]) => ({
    description,
    headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    content: errorContent(
        "RateLimited",
        errors.map((error: ErrorExample) => ({ retryAfter: 60, ...exampleOf(error) }))
    )
});

export const sessionForbiddenResponse = (...errors: ErrorExample[]) =>
    errorResponse(
        "Refused: not logged in, an `Authorization` header was sent, or another cause listed.",
        Responses.notLoggedIn,
        Responses.ApiKeys.apiKeyNotAccepted,
        ...errors
    );

export const apiKeyForbiddenResponse = (scope: string, ...errors: ErrorExample[]) => ({
    ...errorResponse(
        `Refused: not logged in, the API key lacks the \`${scope}\` scope, or another cause listed.`,
        Responses.notLoggedIn,
        Responses.ApiKeys.apiKeyScopeMissing(scope),
        ...errors
    ),
    headers: {
        "WWW-Authenticate": {
            description: `Sent when the API key lacks the scope: \`Bearer realm="vb2007.hu", error="insufficient_scope", scope="${scope}"\`.`,
            schema: { type: "string" }
        }
    }
});

export const components = {
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
                "An API key sent as `Authorization: Bearer vbk_…`. Each operation that takes one lists the scope its key needs."
        }
    },
    schemas: {
        Error: {
            type: "object",
            required: ["error"],
            properties: {
                error: { type: "string" },
                reason: {
                    type: "string",
                    description: "A machine-readable cause, on the answers that list one."
                }
            }
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
                },
                reason: {
                    type: "string",
                    description: "A machine-readable cause, on the answers that list one."
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
        ApiKeyRateLimited: rateLimitedResponse(
            `Over ${FAILED_ATTEMPTS_PER_IP} rejected API keys from this IP address in ${FAILED_ATTEMPTS_WINDOW_MS / 60000} minutes.`,
            Responses.tooManyFailedAttempts
        ),
        ServerError: errorResponse("An unexpected server error.", Responses.internalServerError)
    }
};
