import type { DocsModule } from "../openapi";
import {
    ErrorExample,
    errorResponse,
    rateLimitedResponse,
    sessionForbiddenResponse
} from "../components";
import { Responses } from "../../constants/responses";
import {
    CODE_FAILURES_PER_DAY,
    DEVICE_COOKIE_MAX_AGE_MS,
    EMAIL_AND_IP_SUBNET,
    EMAIL_CODE_LENGTH,
    EMAIL_CODE_MAX_ATTEMPTS,
    EMAIL_CODE_RESEND_SECONDS,
    EMAIL_LOCAL_PART_MAX_LENGTH,
    EMAIL_MAX_LENGTH,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    FAILED_LOGINS_PER_EMAIL,
    GITHUB_OAUTH_MINUTES,
    IP_SUBNET,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    MFA_CHALLENGE_MINUTES,
    MFA_COOKIE_MAX_AGE_MS,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_RESET_CODE_MINUTES,
    PENDING_REGISTRATION_HOURS,
    REGISTRATION_CODE_MINUTES,
    SESSION_MAX_AGE_MS,
    USERNAME_CHECKS_PER_IP,
    USERNAME_CHECKS_WINDOW_MS,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH
} from "../../constants/limits";

const failedAttemptsMinutes: number = FAILED_ATTEMPTS_WINDOW_MS / 60000;
const exampleEmail: string = "alice@example.com";
const exampleUsername: string = "alice";
const examplePassword: string = "correct horse battery";

const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });

const jsonBody = (
    properties: Record<string, object>,
    required: string[],
    example: Record<string, unknown>
) => ({
    required: true,
    content: {
        "application/json": {
            schema: { type: "object", required, properties },
            example
        }
    }
});

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

const limitedResponse = (description: string, ...errors: ErrorExample[]) => ({
    ...rateLimitedResponse(description, ...errors),
    headers: {
        "Retry-After": ref("headers", "RetryAfter"),
        RateLimit: ref("headers", "RateLimit"),
        "RateLimit-Policy": ref("headers", "RateLimitPolicy")
    }
});

const setCookie = (description: string) => ({
    "Set-Cookie": { description, schema: { type: "string" } }
});

const redirectResponse = (
    description: string,
    location: string,
    example: string,
    cookie?: string
) => ({
    description,
    content: {
        "text/plain": {
            schema: { type: "string" },
            example: `Found. Redirecting to ${example}`
        },
        "text/html": {
            schema: { type: "string" },
            example: `<p>Found. Redirecting to ${example}</p>`
        }
    },
    headers: {
        Location: { description: location, schema: { type: "string", format: "uri" } },
        ...(cookie && setCookie(cookie))
    }
});

const sessionCookieSet: string = `\`__Host-VB-AUTH=<token>; Max-Age=${SESSION_MAX_AGE_MS / 1000}; Path=/; HttpOnly; Secure\`, plus \`SameSite=Lax\` in production. It starts the account's only session, which ends its other devices' sessions.`;
const mfaCookieSet: string = `\`__Host-VB-MFA=<userId>.<secret>; Max-Age=${MFA_COOKIE_MAX_AGE_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax\`: the MFA challenge, valid for ${MFA_CHALLENGE_MINUTES} minutes. No session starts.`;
const oauthCookieSet: string = `\`__Host-VB-OAUTH=<state, PKCE verifier and mode>; Max-Age=${GITHUB_OAUTH_MINUTES * 60}; Path=/; HttpOnly; Secure; SameSite=Lax\`, which \`GET /auth/github/callback\` checks and clears.`;

const usernameProperty = {
    type: "string",
    minLength: USERNAME_MIN_LENGTH,
    maxLength: USERNAME_MAX_LENGTH,
    description: `Trimmed at both ends, then at most ${USERNAME_MAX_LENGTH} UTF-16 code units and at least ${USERNAME_MIN_LENGTH} code points that aren't combining marks. No control, invisible or format characters, and no whitespace inside but spaces (a joiner is allowed between emoji). Unique ignoring case and fullwidth forms.`,
    example: exampleUsername
};

const passwordProperty = (description: string) => ({
    type: "string",
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: `${description} ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`
});

const emailProperty = (description: string) => ({
    type: "string",
    description: `${description} Trimmed and lower-cased.`
});

const codeProperty = {
    type: "string",
    description: `The ${EMAIL_CODE_LENGTH} digit code from the mail. Spaces are ignored.`,
    example: "123456"
};

const usernameErrors: string[] = [
    Responses.Authentication.usernameTooShort,
    Responses.Authentication.usernameTooLong,
    Responses.Authentication.usernameInvalidCharacters
];

const passwordErrors: string[] = [
    Responses.Authentication.passwordTooShort,
    Responses.Authentication.passwordTooLong
];

const mailBudgetExample = {
    error: Responses.EmailCodes.mailBudgetUsedUp,
    reason: "mailBudget",
    retryAfter: 36000
};

const mailSendsLimit: string = `${MAIL_SENDS_PER_IP} requests per client IP per ${MAIL_SENDS_WINDOW_MS / 60000} minutes, counting only answers below \`400\` and shared with the other routes that mail a code`;
const codeChecksLimit: string = `${FAILED_ATTEMPTS_PER_ACCOUNT} rejected codes per e-mail address and ${FAILED_ATTEMPTS_PER_IP} per client IP in ${failedAttemptsMinutes} minutes`;
const passwordChecksLimit: string = `${FAILED_ATTEMPTS_PER_ACCOUNT} wrong passwords per account and ${FAILED_ATTEMPTS_PER_IP} per client IP in ${failedAttemptsMinutes} minutes, shared with the other routes that confirm the password`;
const limiterNote: string = "The counters live in memory: they reset when the API restarts.";

const githubLinkPassword = (description: string, required: string[]) =>
    jsonBody({ password: { type: "string", description } }, required, {
        password: examplePassword
    });

const loginErrors: string[] = [
    Responses.GithubOauth.notConfigured,
    Responses.GithubOauth.accessDenied,
    Responses.GithubOauth.invalidState,
    Responses.GithubOauth.githubError,
    Responses.GithubOauth.noVerifiedEmail,
    Responses.GithubOauth.emailExists,
    Responses.GithubOauth.accountSuspended
];

const linkErrors: string[] = [
    Responses.GithubOauth.notConfigured,
    Responses.GithubOauth.accessDenied,
    Responses.GithubOauth.invalidState,
    Responses.GithubOauth.githubError,
    Responses.GithubOauth.notLoggedIn,
    Responses.GithubOauth.passwordRequired,
    Responses.GithubOauth.apiKeyNotAccepted,
    Responses.GithubOauth.githubAlreadyLinked,
    Responses.GithubOauth.githubOtherLinked
];

const codes = (errors: string[]): string => errors.map((code: string) => `\`${code}\``).join(", ");

export const tags: DocsModule["tags"] = [
    {
        name: "authentication",
        description:
            "Registering, logging in and out, and resetting a forgotten password. Logging in sets the `__Host-VB-AUTH` session cookie, which the other operations read."
    },
    {
        name: "github",
        description: `Logging in, signing up and linking accounts with GitHub (OAuth2 with PKCE). The \`GET\` routes are browser navigations that answer with redirects. Failures redirect to \`<site>/login?oauthError=<code>\` or \`<site>/account?oauthError=<code>\` with one of: ${codes([...new Set([...loginErrors, ...linkErrors])])}.`
    }
];

export const paths: DocsModule["paths"] = {
    "/auth/register": {
        post: {
            tags: ["authentication"],
            summary: "Start registering",
            description: `Checks the username, password and address, then mails a ${EMAIL_CODE_LENGTH} digit code, valid for ${REGISTRATION_CODE_MINUTES} minutes, to finish with \`POST /auth/register/verify\`. No account exists until then: only the address and code wait, for ${PENDING_REGISTRATION_HOURS} hours. An address that already has an account gets the same \`202\`, so the answer doesn't reveal it. At most one code per address every ${EMAIL_CODE_RESEND_SECONDS} seconds.\n\nLimited to ${mailSendsLimit}. ${limiterNote}`,
            security: [],
            requestBody: jsonBody(
                {
                    username: usernameProperty,
                    email: {
                        type: "string",
                        format: "email",
                        maxLength: EMAIL_MAX_LENGTH,
                        description: `Trimmed and lower-cased, at most ${EMAIL_LOCAL_PART_MAX_LENGTH} characters before the \`@\`, on a domain that receives mail and isn't disposable.`
                    },
                    password: passwordProperty("The new account's password.")
                },
                ["username", "email", "password"],
                { username: exampleUsername, email: exampleEmail, password: examplePassword }
            ),
            responses: {
                "202": messageResponse(
                    "The code was mailed.",
                    Responses.Authentication.registrationCodeSent(exampleEmail)
                ),
                "400": errorResponse(
                    "A field is missing, empty or not a string, breaks the username or password rules, or the address is malformed, disposable or on a domain that can't receive mail, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingEmailPasswordUsername,
                    ...usernameErrors,
                    ...passwordErrors,
                    Responses.Authentication.invalidEmailFormat,
                    Responses.Authentication.disposableEmail,
                    Responses.Authentication.undeliverableEmailDomain
                ),
                "409": errorResponse(
                    "The username is taken.",
                    Responses.Authentication.usernameTaken
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    `Over the ${MAIL_SENDS_PER_IP} mails per client IP, or within ${EMAIL_CODE_RESEND_SECONDS} seconds of the last code for this address (\`reason: "resendCooldown"\`).`,
                    Responses.tooManyEmails,
                    {
                        error: Responses.EmailCodes.resendTooSoon(EMAIL_CODE_RESEND_SECONDS),
                        retryAfter: EMAIL_CODE_RESEND_SECONDS,
                        reason: "resendCooldown"
                    }
                ),
                "503": {
                    ...errorResponse(
                        "The mail couldn't be sent, which keeps any earlier registration and allows a retry right away, or the day's registration mail is used up (`reason: \"mailBudget\"`, with `retryAfter` seconds until the next UTC midnight).",
                        Responses.EmailCodes.mailFailed,
                        mailBudgetExample
                    ),
                    headers: {
                        "Retry-After": {
                            description: 'Only with `reason: "mailBudget"`.',
                            schema: { type: "integer", minimum: 1 }
                        }
                    }
                },
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/register/resend": {
        post: {
            tags: ["authentication"],
            summary: "Resend the registration code",
            description: `Answers the same \`200\` for every address before looking it up, then mails a new code to a waiting registration, which replaces the old one. Within ${EMAIL_CODE_RESEND_SECONDS} seconds of the last code nothing is sent, so the message says to use the latest code. A failed send is only logged and keeps the old code. Each request that gets the \`200\` counts as one mail of the day's limit.\n\nLimited to ${mailSendsLimit}. ${limiterNote}`,
            security: [],
            requestBody: jsonBody(
                { email: emailProperty("The address being registered.") },
                ["email"],
                { email: exampleEmail }
            ),
            responses: {
                "200": messageResponse(
                    "Answered for every address.",
                    Responses.Authentication.registrationCodeResent
                ),
                "400": errorResponse(
                    "`email` is missing, blank or not a string, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingEmail
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    `Over the ${MAIL_SENDS_PER_IP} mails per client IP.`,
                    Responses.tooManyEmails
                ),
                "503": rateLimitedResponse(
                    "The day's registration mail is used up, the same for every address. `retryAfter` is the seconds until the next UTC midnight.",
                    mailBudgetExample
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/register/verify": {
        post: {
            tags: ["authentication"],
            summary: "Finish registering",
            description: `Checks the mailed code, then creates the account with this username and password, its address confirmed, and logs it in. A code takes ${EMAIL_CODE_MAX_ATTEMPTS} tries. A taken username keeps the registration, so the code still works with another name.\n\nLimited to ${codeChecksLimit}, and to ${CODE_FAILURES_PER_DAY} rejected codes a day per waiting registration (stored with it, so restarts don't reset it). Both answer the same \`429\`. ${limiterNote}`,
            security: [],
            requestBody: jsonBody(
                {
                    email: emailProperty("The address the code was mailed to."),
                    code: codeProperty,
                    username: usernameProperty,
                    password: passwordProperty("The new account's password.")
                },
                ["email", "code", "username", "password"],
                {
                    email: exampleEmail,
                    code: "123456",
                    username: exampleUsername,
                    password: examplePassword
                }
            ),
            responses: {
                "201": messageResponse(
                    "The account exists and is logged in.",
                    Responses.Authentication.registrationSuccess(exampleUsername),
                    setCookie(sessionCookieSet)
                ),
                "400": errorResponse(
                    "A field is missing, empty or not a string, the username or password breaks the rules (no try used), the code is wrong, expired or used up, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingEmailCodeUsernamePassword,
                    ...usernameErrors,
                    ...passwordErrors,
                    Responses.EmailCodes.invalidCode
                ),
                "403": errorResponse(
                    "The new account was deleted before its session started.",
                    Responses.notLoggedIn
                ),
                "409": errorResponse(
                    "The address already has an account (the registration is dropped), or the username was taken meanwhile.",
                    Responses.Authentication.emailAlreadyExists,
                    Responses.Authentication.usernameTaken
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    "Too many rejected codes for this address or from this client IP, or the daily cap of the waiting registration.",
                    Responses.tooManyFailedAttempts
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/username-available": {
        get: {
            tags: ["authentication"],
            summary: "Check a username",
            description: `Tells whether a username is free, by the same rules as registering, so a form can check while it's typed. Waiting registrations don't hold a name.\n\nLimited to ${USERNAME_CHECKS_PER_IP} checks per client IP per ${USERNAME_CHECKS_WINDOW_MS / 1000} seconds, whatever they answer. ${limiterNote}`,
            security: [],
            parameters: [
                {
                    name: "username",
                    in: "query",
                    required: true,
                    description:
                        "The username to check. A missing or repeated parameter counts as an empty name.",
                    schema: usernameProperty
                }
            ],
            responses: {
                "200": {
                    description: "Whether the name is free.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["available"],
                                properties: { available: { type: "boolean" } }
                            },
                            example: { available: true }
                        }
                    }
                },
                "400": errorResponse("The name breaks the username rules.", ...usernameErrors),
                "429": limitedResponse(
                    `Over the ${USERNAME_CHECKS_PER_IP} checks per client IP.`,
                    Responses.tooManyUsernameChecks
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/login": {
        post: {
            tags: ["authentication"],
            summary: "Log in",
            description: `Logs in with the e-mail address and password. An unknown address, a wrong password and an account without a password (made with GitHub) get the same \`403\`, so the answer doesn't reveal which addresses have accounts.\n\nWith an MFA method on, the password starts a challenge instead of a session (\`202\`): finish it through the \`/auth/mfa\` operations.\n\nLimited to ${FAILED_ATTEMPTS_PER_ACCOUNT} failed logins per address from one client IP (an IPv6 client counts as its /${EMAIL_AND_IP_SUBNET}), ${FAILED_LOGINS_PER_EMAIL} per address from all IPs and ${FAILED_ATTEMPTS_PER_IP} per client IP (its /${IP_SUBNET}) in ${failedAttemptsMinutes} minutes, counting \`403\` answers only. A request carrying a valid \`VB-DEVICE\` cookie for the address counts against that cookie's own ${FAILED_LOGINS_PER_EMAIL} per address instead of the shared one. The ${FAILED_LOGINS_PER_EMAIL} per address (shared or per cookie) sends no \`RateLimit\` headers. ${limiterNote}`,
            security: [],
            requestBody: jsonBody(
                {
                    email: emailProperty("The account's address."),
                    password: { type: "string", description: "The account's password." }
                },
                ["email", "password"],
                { email: exampleEmail, password: examplePassword }
            ),
            parameters: [
                {
                    name: "VB-DEVICE",
                    in: "cookie",
                    required: false,
                    description:
                        "Set by an earlier login on this device. Its failed logins count against their own per-address limit.",
                    schema: { type: "string" }
                }
            ],
            responses: {
                "200": messageResponse(
                    "Logged in, without MFA.",
                    Responses.Authentication.loginSuccess(exampleUsername),
                    setCookie(
                        `Two cookies. ${sessionCookieSet} And \`VB-DEVICE=<issued at>.<signature>; Max-Age=${DEVICE_COOKIE_MAX_AGE_MS / 1000}; Path=/auth/login; HttpOnly\`, plus \`Secure; SameSite=Lax\` in production: it stops working once the account's address or password changes.`
                    )
                ),
                "202": {
                    description:
                        "The password is right and MFA is on: no session yet. `methods` lists the methods that are on, in the order `email`, `totp`, `passkey`, `recovery`.",
                    headers: setCookie(mfaCookieSet),
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["mfaRequired", "methods"],
                                properties: {
                                    mfaRequired: { type: "boolean", const: true },
                                    methods: {
                                        type: "array",
                                        minItems: 1,
                                        items: {
                                            type: "string",
                                            enum: ["email", "totp", "passkey", "recovery"]
                                        }
                                    }
                                }
                            },
                            example: { mfaRequired: true, methods: ["email", "recovery"] }
                        }
                    }
                },
                "400": errorResponse(
                    "`email` or `password` is missing, empty (an address of only whitespace too) or not a string, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingEmailPassword
                ),
                "403": errorResponse(
                    "Wrong credentials (also an account deleted while logging in), or the account is suspended.",
                    Responses.Authentication.invalidCredentials,
                    Responses.Authentication.accountSuspended
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    "Too many failed logins for this address or from this client IP, even with the right password.",
                    Responses.tooManyFailedAttempts
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/password-reset": {
        post: {
            tags: ["authentication"],
            summary: "Request a password reset",
            description: `Answers the same \`200\` for every address before anything is stored or mailed. An account that isn't suspended then gets a mail with a ${EMAIL_CODE_LENGTH} digit code (for \`POST /auth/password-reset/confirm\`) and a link to \`<site>/reset-password#token=<token>\` (for \`POST /auth/password-reset/confirm-link\`), both valid for ${PASSWORD_RESET_CODE_MINUTES} minutes. At most one mail every ${EMAIL_CODE_RESEND_SECONDS} seconds: a newer one replaces the code, but each mail's link works until it expires or a reset uses it. Failed sends and a used-up daily mail limit are only logged.\n\nLimited to ${mailSendsLimit}. ${limiterNote}`,
            security: [],
            requestBody: jsonBody({ email: emailProperty("The account's address.") }, ["email"], {
                email: exampleEmail
            }),
            responses: {
                "200": messageResponse(
                    "Answered for every address.",
                    Responses.Authentication.passwordResetSent
                ),
                "400": errorResponse(
                    "`email` is missing, blank or not a string, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingEmail
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    `Over the ${MAIL_SENDS_PER_IP} mails per client IP.`,
                    Responses.tooManyEmails
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/password-reset/confirm": {
        post: {
            tags: ["authentication"],
            summary: "Reset the password with the code",
            description: `Sets the new password with the mailed code. It ends the account's session (log in again) and any MFA challenge, uses up the code and every link, drops a waiting e-mail change, deletes the account's API keys, confirms the address and mails a notice that the password changed. A code takes ${EMAIL_CODE_MAX_ATTEMPTS} tries.\n\nLimited to ${codeChecksLimit}. Over ${CODE_FAILURES_PER_DAY} rejected codes a day for the account, it answers like a wrong code, so the answer doesn't reveal which addresses have accounts. ${limiterNote}`,
            security: [],
            requestBody: jsonBody(
                {
                    email: emailProperty("The account's address."),
                    code: codeProperty,
                    newPassword: passwordProperty("The new password.")
                },
                ["email", "code", "newPassword"],
                { email: exampleEmail, code: "123456", newPassword: examplePassword }
            ),
            responses: {
                "200": messageResponse(
                    "The password is reset.",
                    Responses.Authentication.passwordResetSuccess
                ),
                "400": errorResponse(
                    "A field is missing, empty or not a string, the new password breaks the rules (no try used), the code is wrong, expired, used up or over the daily cap, the address has no account, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingPasswordResetFields,
                    ...passwordErrors,
                    Responses.EmailCodes.invalidCode
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    "Too many rejected codes for this address or from this client IP, even for the right code.",
                    Responses.tooManyFailedAttempts
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/password-reset/confirm-link": {
        post: {
            tags: ["authentication"],
            summary: "Reset the password with the link",
            description: `The same as \`POST /auth/password-reset/confirm\`, with the token from the mailed link instead of the address and code. It also uses up the code and every link. Only one of parallel requests with the same token succeeds.\n\nLimited to ${FAILED_ATTEMPTS_PER_IP} rejected tokens per client IP in ${failedAttemptsMinutes} minutes, and not per address, so nobody can block the owner's link. ${limiterNote}`,
            security: [],
            requestBody: jsonBody(
                {
                    token: {
                        type: "string",
                        pattern: "^[0-9a-f]{24}\\.[\\w-]{43}$",
                        description:
                            "The part of the link after `#token=`: `<user id>.<secret>`. The fragment never reaches a server, so it stays out of logs."
                    },
                    newPassword: passwordProperty("The new password.")
                },
                ["token", "newPassword"],
                {
                    token: `0123456789abcdef01234567.${"x".repeat(43)}`,
                    newPassword: examplePassword
                }
            ),
            responses: {
                "200": messageResponse(
                    "The password is reset.",
                    Responses.Authentication.passwordResetSuccess
                ),
                "400": errorResponse(
                    "A field is missing, empty or not a string, the new password breaks the rules (the link isn't used up), the token is malformed, wrong, expired or used, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.Authentication.missingPasswordResetLinkFields,
                    ...passwordErrors,
                    Responses.Authentication.invalidPasswordResetLink
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    "Too many rejected tokens from this client IP, even for a valid one.",
                    Responses.tooManyFailedAttempts
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/logout": {
        post: {
            tags: ["authentication"],
            summary: "Log out",
            description:
                "Ends the account's session and clears the `__Host-VB-AUTH` cookie. With a `__Host-VB-MFA` cookie it also drops that MFA challenge and clears the cookie. Without a session it still answers `200`.",
            security: [{ session: [] }],
            responses: {
                "200": messageResponse(
                    "Logged out.",
                    Responses.Authentication.logoutSuccess,
                    setCookie("Clears `__Host-VB-AUTH`, and `__Host-VB-MFA` when one was sent.")
                ),
                "403": ref("responses", "ApiKeyNotAccepted"),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/github": {
        get: {
            tags: ["github"],
            summary: "Log in with GitHub",
            description: `Starts a GitHub login: redirects to GitHub's authorize page, which comes back to \`GET /auth/github/callback\`. The first GitHub login of an unknown GitHub account creates an account without a password, named after the GitHub login and with its primary verified e-mail address. The flow is valid for ${GITHUB_OAUTH_MINUTES} minutes.`,
            security: [],
            responses: {
                "302": redirectResponse(
                    "To GitHub, or back to the site's login page when GitHub login isn't set up on the server.",
                    `GitHub's authorize URL, or \`<site>/login?oauthError=${Responses.GithubOauth.notConfigured}\`.`,
                    "https://github.com/login/oauth/authorize?client_id=…&state=…&code_challenge=…&code_challenge_method=S256",
                    `Only with the redirect to GitHub: ${oauthCookieSet}`
                )
            }
        }
    },
    "/auth/github/link": {
        get: {
            tags: ["github"],
            summary: "Relink GitHub",
            description: `Relinks GitHub to the logged-in account when it has no password (one made with GitHub), for example to confirm it's the owner before setting a password or deleting the account. An account with a password starts with \`POST /auth/github/link\` instead. It never replaces another linked GitHub account. A browser navigation, so problems redirect to \`<site>/account?oauthError=<code>\`: ${codes([Responses.GithubOauth.notLoggedIn, Responses.GithubOauth.passwordRequired, Responses.GithubOauth.notConfigured, Responses.GithubOauth.githubError])}. The flow is valid for ${GITHUB_OAUTH_MINUTES} minutes.`,
            security: [{ session: [] }],
            responses: {
                "302": redirectResponse(
                    "To GitHub, or back to the site's account page with an `oauthError`.",
                    "GitHub's authorize URL, or `<site>/account?oauthError=<code>`.",
                    `https://vb2007.hu/account?oauthError=${Responses.GithubOauth.passwordRequired}`,
                    `Only with the redirect to GitHub: ${oauthCookieSet}`
                ),
                "403": ref("responses", "ApiKeyNotAccepted")
            }
        },
        post: {
            tags: ["github"],
            summary: "Start linking GitHub",
            description: `Starts linking GitHub to the logged-in account, confirmed with its password when it has one, and answers the authorize URL for the browser to navigate to. It stores a proof bound to this session and flow, valid for ${GITHUB_OAUTH_MINUTES} minutes, which the callback uses up; starting another link replaces it.\n\nWrong passwords are limited to ${passwordChecksLimit}. ${limiterNote}`,
            security: [{ session: [] }],
            requestBody: {
                ...githubLinkPassword(
                    "The account's password. Needed when the account has one, and ignored otherwise.",
                    []
                ),
                required: false
            },
            responses: {
                "200": {
                    description: "Navigate to `url` to continue on GitHub.",
                    headers: setCookie(oauthCookieSet),
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["url"],
                                properties: { url: { type: "string", format: "uri" } }
                            },
                            example: {
                                url: "https://github.com/login/oauth/authorize?client_id=…&state=…&code_challenge=…&code_challenge_method=S256"
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "The account has a password and `password` is missing, empty or not a string, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.GithubOauth.missingPassword
                ),
                "403": sessionForbiddenResponse(Responses.Authentication.incorrectPassword),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    "Too many wrong passwords for this account or from this client IP.",
                    Responses.tooManyFailedAttempts
                ),
                "503": errorResponse(
                    "GitHub login isn't set up on the server.",
                    Responses.GithubOauth.notConfigured
                ),
                "500": ref("responses", "ServerError")
            }
        },
        delete: {
            tags: ["github"],
            summary: "Unlink GitHub",
            description: `Unlinks GitHub from the logged-in account, confirmed with its password. An account without a password can't, since GitHub is then its only way to log in: set a password first.\n\nWrong passwords are limited to ${passwordChecksLimit}. ${limiterNote}`,
            security: [{ session: [] }],
            requestBody: githubLinkPassword("The account's password.", ["password"]),
            responses: {
                "200": messageResponse(
                    "GitHub is unlinked.",
                    Responses.GithubOauth.githubUnlinkedSuccess
                ),
                "400": errorResponse(
                    "`password` is missing, empty or not a string, or the body isn't valid JSON.",
                    Responses.invalidJson,
                    Responses.GithubOauth.missingPassword
                ),
                "403": sessionForbiddenResponse(
                    Responses.GithubOauth.cannotUnlinkWithoutPassword,
                    Responses.Authentication.incorrectPassword
                ),
                "404": errorResponse(
                    "No GitHub account is linked.",
                    Responses.GithubOauth.githubNotLinked
                ),
                "413": ref("responses", "RequestTooLarge"),
                "429": limitedResponse(
                    "Too many wrong passwords for this account or from this client IP.",
                    Responses.tooManyFailedAttempts
                ),
                "500": ref("responses", "ServerError")
            }
        }
    },
    "/auth/github/callback": {
        get: {
            tags: ["github"],
            summary: "Finish a GitHub flow",
            description: `GitHub redirects here; it isn't called directly. It always clears the \`__Host-VB-OAUTH\` cookie, checks GitHub's \`error\`, then the \`state\` against the cookie and, for a link, the \`__Host-VB-AUTH\` session and the proof \`POST\` or \`GET /auth/github/link\` stored, before exchanging the code.\n\n- A login logs in the linked account, or the account whose address matches when it is already linked to this GitHub account, or else signs up a new account. A password account with the same address isn't joined: its owner links GitHub from the account instead (\`emailExists\`). With MFA on, it starts the MFA challenge and redirects to \`<site>/login?mfa=required\` instead of starting a session.\n- A link links this GitHub account to the session's account and starts a new session, so the old \`__Host-VB-AUTH\` cookie stops working.\n\nLogin failures (and failures before the flow is known) redirect to \`<site>/login?oauthError=<code>\` with ${codes(loginErrors.filter((code: string) => code !== Responses.GithubOauth.notConfigured))}. Link failures redirect to \`<site>/account?oauthError=<code>\` with ${codes([Responses.GithubOauth.accessDenied, Responses.GithubOauth.invalidState, Responses.GithubOauth.githubError, Responses.GithubOauth.apiKeyNotAccepted, Responses.GithubOauth.notLoggedIn, Responses.GithubOauth.githubAlreadyLinked, Responses.GithubOauth.githubOtherLinked])}.`,
            security: [],
            parameters: [
                {
                    name: "code",
                    in: "query",
                    required: false,
                    description: "GitHub's authorization code.",
                    schema: { type: "string" }
                },
                {
                    name: "state",
                    in: "query",
                    required: false,
                    description: "Must match the `__Host-VB-OAUTH` cookie's state.",
                    schema: { type: "string" }
                },
                {
                    name: "error",
                    in: "query",
                    required: false,
                    description: `Set by GitHub when the flow failed: \`access_denied\` (the user cancelled) redirects with \`${Responses.GithubOauth.accessDenied}\`, anything else with \`${Responses.GithubOauth.githubError}\`.`,
                    schema: { type: "string" }
                },
                {
                    name: "__Host-VB-OAUTH",
                    in: "cookie",
                    required: false,
                    description:
                        "Set when the flow started. Without it, or with a different state, the callback redirects with `invalidState`.",
                    schema: { type: "string" }
                }
            ],
            responses: {
                "302": redirectResponse(
                    "Back to the site, with or without a session.",
                    "`<site>` after a login, `<site>/login?mfa=required` when MFA is on, `<site>/account?github=linked` after a link, or `<site>/login?oauthError=<code>` or `<site>/account?oauthError=<code>`.",
                    "https://vb2007.hu",
                    `Clears \`__Host-VB-OAUTH\`. A login or link also sets ${sessionCookieSet} With MFA on, a login sets ${mfaCookieSet}`
                )
            }
        }
    }
};
