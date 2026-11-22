import type { DocsModule } from "../openapi";
import {
    apiKeyForbiddenResponse,
    errorResponse,
    rateLimitedResponse,
    sessionForbiddenResponse
} from "../components";
import { Responses } from "../../constants/responses";
import {
    CODE_FAILURES_PER_DAY,
    EMAIL_CHANGE_CODE_MINUTES,
    EMAIL_CODE_LENGTH,
    EMAIL_CODE_MAX_ATTEMPTS,
    EMAIL_CODE_RESEND_SECONDS,
    EMAIL_MAX_LENGTH,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    GITHUB_REAUTH_MINUTES,
    MAIL_SENDS_PER_IP,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH
} from "../../constants/limits";
import { sessionCookie } from "../../helpers/session";

const messageResponse = (description: string, message: string, headers?: object) => ({
    description,
    ...(headers && { headers }),
    content: {
        "application/json": {
            schema: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string" } }
            },
            example: { message }
        }
    }
});

const jsonBody = (schema: object, example: object) => ({
    required: true,
    content: { "application/json": { schema, example } }
});

const password = (description: string) => ({
    type: "string",
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description
});

const newSessionCookie = {
    "Set-Cookie": {
        description: `A new \`${sessionCookie}\` session cookie: the earlier one stops working.`,
        schema: { type: "string" }
    }
};

const limiterHeaders = {
    "Retry-After": { $ref: "#/components/headers/RetryAfter" },
    RateLimit: { $ref: "#/components/headers/RateLimit" },
    "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" }
};

const passwordChecksLimited = {
    ...rateLimitedResponse(
        `After ${FAILED_ATTEMPTS_PER_ACCOUNT} rejected confirmations on this account, or ${FAILED_ATTEMPTS_PER_IP} from this IP address, in 15 minutes.`,
        Responses.tooManyFailedAttempts
    ),
    headers: limiterHeaders
};

const passwordLengthErrors = [
    Responses.Authentication.passwordTooShort,
    Responses.Authentication.passwordTooLong
];

const serverError = { $ref: "#/components/responses/ServerError" };
const requestTooLarge = { $ref: "#/components/responses/RequestTooLarge" };

export const tags: DocsModule["tags"] = [
    { name: "account", description: "The logged-in user's own account." }
];

export const components: DocsModule["components"] = {
    schemas: {
        Account: {
            type: "object",
            required: [
                "_id",
                "username",
                "email",
                "createdAt",
                "hasPassword",
                "emailVerified",
                "pendingEmail",
                "mfa",
                "isSuperuser"
            ],
            properties: {
                _id: { type: "string", pattern: "^[0-9a-f]{24}$" },
                username: { type: "string" },
                email: { type: "string", format: "email" },
                githubId: { type: "string", description: "Only when GitHub is linked." },
                githubLogin: { type: "string", description: "Only when GitHub is linked." },
                createdAt: { type: "string", format: "date-time" },
                hasPassword: {
                    type: "boolean",
                    description: "`false` for an account made with GitHub that set none yet."
                },
                emailVerified: { type: "boolean" },
                pendingEmail: {
                    type: ["string", "null"],
                    format: "email",
                    description:
                        "The address a `PATCH /user/email` waits to confirm, while its code is still valid and has tries left."
                },
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
                isSuperuser: { type: "boolean" }
            }
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/user": {
        get: {
            tags: ["account"],
            summary: "Get the account",
            description: "Returns the logged-in user's account, or the API key's account.",
            security: [{ session: [] }, { apiKey: ["account:read"] }],
            responses: {
                "200": {
                    description: "The account.",
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/Account" },
                            example: {
                                _id: "6740c0ffee0000000000abcd",
                                username: "vb2007",
                                email: "user@example.com",
                                githubId: "12345678",
                                githubLogin: "vb2007",
                                createdAt: "2026-11-01T10:00:00.000Z",
                                hasPassword: true,
                                emailVerified: true,
                                pendingEmail: null,
                                mfa: {
                                    email: false,
                                    totp: true,
                                    passkeys: 1,
                                    recoveryCodesLeft: 10
                                },
                                isSuperuser: false
                            }
                        }
                    }
                },
                "401": { $ref: "#/components/responses/InvalidApiKey" },
                "403": apiKeyForbiddenResponse("account:read"),
                "429": { $ref: "#/components/responses/ApiKeyRateLimited" },
                "500": serverError
            }
        },
        delete: {
            tags: ["account"],
            summary: "Delete the account",
            description: `Deletes the account with its pastes, short URLs, uploads and their files, its API keys and passkeys, ends the session and clears its cookie. An account with a password confirms it with \`password\`. One without (made with GitHub) sends its own \`username\` instead, and needs a GitHub login or relink within the last ${GITHUB_REAUTH_MINUTES} minutes from this session. A refusal deletes nothing.`,
            security: [{ session: [] }],
            requestBody: jsonBody(
                {
                    type: "object",
                    properties: {
                        password: {
                            type: "string",
                            description: "Required when the account has a password."
                        },
                        username: {
                            type: "string",
                            description: "Required when the account has no password."
                        }
                    }
                },
                { password: "correct horse battery staple" }
            ),
            responses: {
                "200": messageResponse(
                    "The account is deleted and the session cookie cleared.",
                    Responses.Users.userDeletedSuccess,
                    {
                        "Set-Cookie": {
                            description: `Clears the \`${sessionCookie}\` cookie.`,
                            schema: { type: "string" }
                        }
                    }
                ),
                "400": errorResponse(
                    "Invalid JSON, or the confirming field is missing, empty or not a string.",
                    Responses.invalidJson,
                    Responses.Users.missingDeletePassword,
                    Responses.Users.missingDeleteUsername
                ),
                "403": sessionForbiddenResponse(
                    Responses.Authentication.incorrectPassword,
                    Responses.Users.incorrectDeleteUsername,
                    Responses.Users.githubReauthRequiredToDelete(GITHUB_REAUTH_MINUTES)
                ),
                "413": requestTooLarge,
                "429": passwordChecksLimited,
                "500": serverError
            }
        }
    },
    "/user/password": {
        post: {
            tags: ["account"],
            summary: "Set a password",
            description: `Sets a password on an account that has none (made with GitHub), after a GitHub login or relink within the last ${GITHUB_REAUTH_MINUTES} minutes from this session. Starts a new session and voids any password reset code or link mailed before.`,
            security: [{ session: [] }],
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["password"],
                    properties: { password: password("The new password, in characters.") }
                },
                { password: "correct horse battery staple" }
            ),
            responses: {
                "200": messageResponse(
                    "The password is set, and a new session started.",
                    Responses.Users.passwordSetSuccess,
                    newSessionCookie
                ),
                "400": errorResponse(
                    "Invalid JSON, or the password is missing, not a string or breaks the length rules.",
                    Responses.invalidJson,
                    Responses.Users.missingPassword,
                    ...passwordLengthErrors
                ),
                "403": sessionForbiddenResponse(
                    Responses.Users.githubReauthRequired(GITHUB_REAUTH_MINUTES)
                ),
                "409": errorResponse(
                    "The account already has a password: change it with `PATCH /user/password`.",
                    Responses.Users.passwordAlreadySet
                ),
                "413": requestTooLarge,
                "500": serverError
            }
        },
        patch: {
            tags: ["account"],
            summary: "Change the password",
            description:
                "Changes the password after checking the current one. Starts a new session, and voids any password reset code or link mailed before, a waiting e-mail change and an unfinished MFA login.",
            security: [{ session: [] }],
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["currentPassword", "newPassword"],
                    properties: {
                        currentPassword: { type: "string" },
                        newPassword: password("In characters.")
                    }
                },
                {
                    currentPassword: "correct horse battery staple",
                    newPassword: "another long passphrase"
                }
            ),
            responses: {
                "200": messageResponse(
                    "The password is changed, and a new session started.",
                    Responses.Users.passwordChangedSuccess,
                    newSessionCookie
                ),
                "400": errorResponse(
                    "Invalid JSON, a field is missing, empty or not a string, or the new password breaks the length rules.",
                    Responses.invalidJson,
                    Responses.Users.missingPasswords,
                    ...passwordLengthErrors
                ),
                "403": sessionForbiddenResponse(Responses.Authentication.incorrectPassword),
                "409": errorResponse(
                    "The account has no password: set one with `POST /user/password`.",
                    Responses.Users.noPasswordToChange
                ),
                "413": requestTooLarge,
                "429": passwordChecksLimited,
                "500": serverError
            }
        }
    },
    "/user/email": {
        patch: {
            tags: ["account"],
            summary: "Start an e-mail change",
            description: `Mails a ${EMAIL_CODE_LENGTH} digit code, valid for ${EMAIL_CHANGE_CODE_MINUTES} minutes, to the new address; \`POST /user/email/confirm\` switches to it. Until then the account keeps its address and \`GET /user\` shows the new one as \`pendingEmail\`. The address is trimmed and lower-cased. Another account's address and the superuser's get the same \`202\` and code: only the confirm refuses them. Sending the current address answers \`200\` and mails nothing. A new code replaces the one waiting.`,
            security: [{ session: [] }],
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["email", "password"],
                    properties: {
                        email: { type: "string", format: "email", maxLength: EMAIL_MAX_LENGTH },
                        password: { type: "string", description: "The current password." }
                    }
                },
                { email: "new@example.com", password: "correct horse battery staple" }
            ),
            responses: {
                "200": messageResponse(
                    "The address is already the account's own: nothing changes.",
                    Responses.Users.emailUpdatedSuccess
                ),
                "202": messageResponse(
                    "The code was mailed to the new address.",
                    Responses.Users.emailChangeCodeSent("new@example.com")
                ),
                "400": errorResponse(
                    "Invalid JSON, a field is missing, empty or not a string, or the address is malformed, disposable or its domain can't receive mail.",
                    Responses.invalidJson,
                    Responses.Authentication.missingEmailPassword,
                    Responses.Authentication.invalidEmailFormat,
                    Responses.Authentication.disposableEmail,
                    Responses.Authentication.undeliverableEmailDomain
                ),
                "403": sessionForbiddenResponse(
                    Responses.Users.superuserEmailChange,
                    Responses.Authentication.incorrectPassword
                ),
                "409": errorResponse(
                    "The account has no password: set one with `POST /user/password` first.",
                    Responses.Users.noPasswordToChangeEmail
                ),
                "413": requestTooLarge,
                "429": {
                    ...rateLimitedResponse(
                        `After ${FAILED_ATTEMPTS_PER_ACCOUNT} wrong passwords on this account or ${FAILED_ATTEMPTS_PER_IP} from this IP address in 15 minutes, after ${MAIL_SENDS_PER_IP} successful requests from this IP address in an hour, or (with \`reason: "resendCooldown"\`, no \`RateLimit\` headers) within ${EMAIL_CODE_RESEND_SECONDS} seconds of the last code.`,
                        Responses.tooManyFailedAttempts,
                        Responses.tooManyEmails,
                        {
                            error: Responses.EmailCodes.resendTooSoon(60),
                            reason: "resendCooldown"
                        }
                    ),
                    headers: limiterHeaders
                },
                "500": serverError,
                "503": {
                    ...errorResponse(
                        "The code couldn't be mailed, and the earlier waiting change (if any) is kept. With `reason: \"mailBudget\"` the day's mail limit is used up, and `retryAfter` gives the seconds until the next UTC midnight.",
                        Responses.EmailCodes.mailFailed,
                        {
                            error: Responses.EmailCodes.mailBudgetUsedUpForAccounts,
                            reason: "mailBudget",
                            retryAfter: 3600
                        }
                    ),
                    headers: {
                        "Retry-After": {
                            description: 'Only with `reason: "mailBudget"`: same as `retryAfter`.',
                            schema: { type: "integer", minimum: 1 }
                        }
                    }
                }
            }
        }
    },
    "/user/email/confirm": {
        post: {
            tags: ["account"],
            summary: "Confirm an e-mail change",
            description: `Switches the account to the address \`PATCH /user/email\` mailed the code to, marks it confirmed (\`emailVerified\`) and mails a notice to the old address. Voids any password reset code or link and an unfinished MFA login. Spaces in the code are ignored. A code takes ${EMAIL_CODE_MAX_ATTEMPTS} tries, and an account at most ${CODE_FAILURES_PER_DAY} wrong codes within 24 hours of the first one.`,
            security: [{ session: [] }],
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["code"],
                    properties: { code: { type: "string", pattern: "^[\\d\\s]+$" } }
                },
                { code: "123456" }
            ),
            responses: {
                "200": messageResponse(
                    "The address is changed.",
                    Responses.Users.emailUpdatedSuccess
                ),
                "400": errorResponse(
                    "Invalid JSON, the code is missing, empty or not a string, or it's wrong, expired, used up or there's no waiting change.",
                    Responses.invalidJson,
                    Responses.Users.missingCode,
                    Responses.EmailCodes.invalidCode
                ),
                "403": sessionForbiddenResponse(Responses.Users.emailReservedForSuperuser),
                "409": errorResponse(
                    "Another account has the address. The waiting change is dropped.",
                    Responses.Authentication.emailAlreadyExists
                ),
                "413": requestTooLarge,
                "429": {
                    ...rateLimitedResponse(
                        `After ${FAILED_ATTEMPTS_PER_ACCOUNT} wrong codes on this account or ${FAILED_ATTEMPTS_PER_IP} from this IP address in 15 minutes, or (without \`RateLimit\` headers) ${CODE_FAILURES_PER_DAY} on this account within 24 hours.`,
                        Responses.tooManyFailedAttempts
                    ),
                    headers: limiterHeaders
                },
                "500": serverError
            }
        }
    },
    "/users/{id}": {
        patch: {
            tags: ["account"],
            summary: "Change the username",
            description: `Renames the account. The username is trimmed, then has to be at most ${USERNAME_MAX_LENGTH} UTF-16 code units and at least ${USERNAME_MIN_LENGTH} characters, without invisible or control characters or whitespace other than spaces. Case and inner spaces are kept, and usernames are unique ignoring case.`,
            security: [{ session: [] }, { apiKey: ["account:write"] }],
            parameters: [
                {
                    name: "id",
                    in: "path",
                    required: true,
                    description:
                        "The account's own `_id`. Any other value answers `403`, the superuser's included.",
                    schema: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
                }
            ],
            requestBody: jsonBody(
                {
                    type: "object",
                    required: ["username"],
                    properties: {
                        username: {
                            type: "string",
                            minLength: USERNAME_MIN_LENGTH,
                            maxLength: USERNAME_MAX_LENGTH
                        }
                    }
                },
                { username: "new name" }
            ),
            responses: {
                "200": messageResponse(
                    "The username is changed.",
                    Responses.Users.userUpdatedSuccess
                ),
                "400": errorResponse(
                    "Invalid JSON, or the username is missing, not a string or breaks the rules.",
                    Responses.invalidJson,
                    Responses.Users.missingUsername,
                    Responses.Authentication.usernameTooShort,
                    Responses.Authentication.usernameTooLong,
                    Responses.Authentication.usernameInvalidCharacters
                ),
                "401": { $ref: "#/components/responses/InvalidApiKey" },
                "403": apiKeyForbiddenResponse("account:write", Responses.notAuthorized),
                "409": errorResponse(
                    "Another account has the username.",
                    Responses.Authentication.usernameTaken
                ),
                "413": requestTooLarge,
                "429": { $ref: "#/components/responses/ApiKeyRateLimited" },
                "500": serverError
            }
        }
    }
};
