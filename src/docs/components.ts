import http from "http";

import { Responses } from "../constants/responses";
import {
    CODE_FAILURES_WINDOW_MS,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    GITHUB_REAUTH_MINUTES,
    JSON_BODY_MAX_BYTES
} from "../constants/limits";
import { objectIdPattern } from "../helpers/prisma";
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

export const duration = (ms: number): string => {
    const [count, unit] = ms % 3600000 === 0 ? [ms / 3600000, "hour"] : [ms / 60000, "minute"];

    return `${count} ${unit}${count === 1 ? "" : "s"}`;
};

export const badRequest: string = http.STATUS_CODES[400];

export const failedAttemptsWindow: string = duration(FAILED_ATTEMPTS_WINDOW_MS);

export const codeFailuresWindow: string = duration(CODE_FAILURES_WINDOW_MS);

export const objectId = { type: "string", pattern: objectIdPattern.source };

export const objectIdParameter = (description: string, example?: string) => ({
    name: "id",
    in: "path",
    required: true,
    description,
    schema: objectId,
    ...(example && { example })
});

export const listQueryParameter = (name: string, description: string, schema: object) => ({
    name,
    in: "query",
    required: false,
    description: `${description} Given more than once, or invalid, it answers \`400\`.`,
    schema
});

export const jsonBody = (schema: object, example: unknown) => ({
    required: true,
    content: { "application/json": { schema, example } }
});

export const setCookie = (description: string) => ({
    "Set-Cookie": { description, schema: { type: "string" } }
});

export const messageResponse = (
    description: string,
    message: string,
    {
        headers,
        properties = {},
        example = {},
        required = []
    }: {
        headers?: object;
        properties?: Record<string, object>;
        example?: Record<string, unknown>;
        required?: string[];
    } = {}
) => ({
    description,
    ...(headers && { headers }),
    content: {
        "application/json": {
            schema: {
                type: "object",
                required: ["message", ...required],
                properties: { message: { type: "string" }, ...properties }
            },
            example: { message, ...example }
        }
    }
});

export const serverError = { $ref: "#/components/responses/ServerError" };

export const requestTooLarge = { $ref: "#/components/responses/RequestTooLarge" };

export const apiKeyResponses = {
    "401": { $ref: "#/components/responses/InvalidApiKey" },
    "429": { $ref: "#/components/responses/ApiKeyRateLimited" },
    "500": serverError
};

export const errorResponse = (description: string, ...errors: ErrorExample[]) => ({
    description,
    content: errorContent("Error", errors.map(exampleOf))
});

export const rateLimitedResponse = (description: string, ...errors: ErrorExample[]) => ({
    description,
    headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    content: errorContent(
        "RateLimited",
        errors.map((example: ErrorExample) => {
            const { error, ...fields } = exampleOf(example);

            return { error, retryAfter: 60, ...fields };
        })
    )
});

const rateLimitHeaders = {
    "Retry-After": { $ref: "#/components/headers/RetryAfter" },
    RateLimit: { $ref: "#/components/headers/RateLimit" },
    "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" }
};

export const limitedResponse = (description: string, ...errors: ErrorExample[]) => ({
    ...rateLimitedResponse(description, ...errors),
    headers: rateLimitHeaders
});

export const passwordChecksLimited = limitedResponse(
    `After ${FAILED_ATTEMPTS_PER_ACCOUNT} rejected confirmations for this account, or ${FAILED_ATTEMPTS_PER_IP} from this IP address, in ${failedAttemptsWindow}: wrong passwords, and on \`DELETE /user\` a wrong username. The count is shared with every operation that checks the account's password: the MFA and passkey settings, the password and e-mail changes, deleting the account, linking or unlinking GitHub and creating or rotating API keys.`,
    Responses.tooManyFailedAttempts
);

export const reauthBody = {
    required: false,
    content: {
        "application/json": {
            schema: { $ref: "#/components/schemas/MfaReauth" },
            example: { password: "correct horse battery staple" }
        }
    }
};

export const reauthErrors: ErrorExample[] = [
    Responses.Authentication.incorrectPassword,
    Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
];

export const reauthCheckDescription: string = `An account with a password sends it; one without (made with GitHub) sends none, but needs a GitHub login or relink in the last ${GITHUB_REAUTH_MINUTES} minutes from this session.`;

export const reauthDescription: string = `${reauthCheckDescription} The change is written only while the session is still live and the password unchanged (or the GitHub confirmation still recent), else \`403\`.`;

export const recoveryCodesExample: string[] = [
    "aaaaa-aaaaa",
    "bbbbb-bbbbb",
    "ccccc-ccccc",
    "ddddd-ddddd",
    "eeeee-eeeee",
    "fffff-fffff",
    "ggggg-ggggg",
    "hhhhh-hhhhh",
    "iiiii-iiiii",
    "jjjjj-jjjjj"
];

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
        },
        clientAuth: {
            type: "http",
            scheme: "basic",
            description:
                "A registered first-party app's client id and secret, sent as `Authorization: Basic base64(client_id:client_secret)`."
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
                },
                retryAfter: {
                    type: "integer",
                    minimum: 1,
                    description: 'With `reason: "mailBudget"`: seconds until the next UTC midnight.'
                },
                attemptsLeft: {
                    type: "integer",
                    minimum: 0,
                    description:
                        "On a wrong MFA proof or TOTP setup code: the tries the challenge (or the TOTP setup) has left after this one, `0` on the last."
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
        },
        RateLimit: {
            description:
                'The limiter\'s state (IETF draft 8): requests left and seconds until it resets, e.g. `"100-in-15min"; r=99; t=900`.',
            schema: { type: "string" }
        },
        RateLimitPolicy: {
            description:
                "The limiter's policy (IETF draft 8): its quota, window in seconds and a hash of the client's key, e.g. `\"100-in-15min\"; q=100; w=900; pk=:…:`.",
            schema: { type: "string" }
        }
    },
    responses: {
        RequestTooLarge: errorResponse(
            `The JSON body is over ${JSON_BODY_MAX_BYTES / 1024} KiB.`,
            Responses.requestTooLarge
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
        ApiKeyRateLimited: limitedResponse(
            `After ${FAILED_ATTEMPTS_PER_IP} rejected API keys from this IP address in ${failedAttemptsWindow}, counted for every client sharing it, e.g. behind a NAT.`,
            Responses.tooManyFailedAttempts
        ),
        InvalidClient: {
            description:
                "The client credentials are missing, malformed, unknown or wrong. The body has the RFC 6749 §5.2 shape.",
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["error", "error_description"],
                        properties: {
                            error: { type: "string", const: "invalid_client" },
                            error_description: { type: "string" }
                        }
                    },
                    example: {
                        error: "invalid_client",
                        error_description: Responses.OAuth.invalidClient
                    }
                }
            },
            headers: {
                "WWW-Authenticate": {
                    description: 'Always `Basic realm="vb2007.hu"`.',
                    schema: { type: "string" }
                }
            }
        },
        ServerError: errorResponse("An unexpected server error.", Responses.internalServerError)
    }
};
