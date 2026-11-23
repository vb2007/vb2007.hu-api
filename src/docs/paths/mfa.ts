import type { DocsModule } from "../openapi";
import {
    codeFailuresWindow,
    duration,
    errorResponse,
    failedAttemptsWindow,
    limitedResponse,
    messageResponse,
    passwordChecksLimited,
    reauthBody,
    reauthDescription,
    reauthErrors,
    recoveryCodesExample,
    requestTooLarge,
    serverError,
    sessionForbiddenResponse,
    setCookie
} from "../components";
import { Responses } from "../../constants/responses";
import { mfaCookie } from "../../helpers/mfa";
import { deviceCookie } from "../../helpers/deviceCookie";
import { sessionCookie } from "../../helpers/session";
import {
    CODE_FAILURES_PER_DAY,
    EMAIL_CODE_LENGTH,
    EMAIL_CODE_RESEND_SECONDS,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    GITHUB_REAUTH_MINUTES,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    MFA_CHALLENGE_ATTEMPTS,
    MFA_CHALLENGE_MINUTES,
    MFA_EMAILS_PER_DAY,
    MFA_RECOVERY_CODES,
    MFA_TOTP_SETUP_ATTEMPTS,
    MFA_TOTP_SETUP_MINUTES,
    SECURITY_NOTICES_PER_DAY
} from "../../constants/limits";

const loginSucceeded = messageResponse(
    "The second step passed: the session started, replacing the account's earlier one.",
    Responses.Authentication.loginSuccess("vb2007")
);

const loginCookies = setCookie(
    `Sets \`${sessionCookie}\` (the session), clears \`${mfaCookie}\` and, after a password login (not a GitHub one), sets \`${deviceCookie}\`.`
);

const recoveryCodesProperty = {
    recoveryCodes: { $ref: "#/components/schemas/MfaRecoveryCodes" }
};

const firstRecoveryCodes = {
    properties: recoveryCodesProperty,
    example: { recoveryCodes: recoveryCodesExample }
};

const verifyLimited = limitedResponse(
    `After ${CODE_FAILURES_PER_DAY} wrong tries for this account in ${codeFailuresWindow} (no try is used), or ${FAILED_ATTEMPTS_PER_IP} rejected codes from this IP address in ${failedAttemptsWindow}. The per-IP count is shared between \`POST /auth/mfa/verify\` and \`/auth/mfa/verify-link\`, and with \`POST /auth/register/verify\` and \`POST /auth/password-reset/confirm\`, but not their count per e-mail address: an \`email\` in the body is ignored.`,
    Responses.tooManyFailedAttempts
);

const challengeCookie = { $ref: "#/components/parameters/MfaChallengeCookie" };

const challengeExpired = { $ref: "#/components/responses/MfaChallengeExpired" };

export const tags: DocsModule["tags"] = [
    {
        name: "MFA",
        description: `Multi-factor login. With e-mail MFA or TOTP on, a right password or GitHub login only starts a challenge (the \`${mfaCookie}\` cookie), valid for ${MFA_CHALLENGE_MINUTES} minutes and ${MFA_CHALLENGE_ATTEMPTS} tries, that one of the account's methods has to pass. Passkeys and recovery codes are backup methods: they can pass a challenge but never start one. Security notices about account changes are mailed at most ${SECURITY_NOTICES_PER_DAY} times per account in ${codeFailuresWindow}; past that they're dropped without an error.`
    }
];

export const components: DocsModule["components"] = {
    parameters: {
        MfaChallengeCookie: {
            name: mfaCookie,
            in: "cookie",
            required: true,
            description:
                'The login\'s challenge, `<userId>.<secret>`, set by `POST /auth/login` or the GitHub login when MFA is on. Without it, or with a malformed one, the answer is `403` with `reason: "noChallenge"`.',
            schema: { type: "string", pattern: "^[0-9a-f]{24}\\.[\\w-]{43}$" }
        }
    },
    schemas: {
        MfaMethod: {
            type: "string",
            enum: ["email", "totp", "passkey", "recovery"],
            description:
                "`passkey` and `recovery` are listed only next to `email` or `totp`, and always after them."
        },
        MfaMethods: {
            type: "object",
            required: ["methods"],
            properties: {
                methods: {
                    type: "array",
                    minItems: 1,
                    items: { $ref: "#/components/schemas/MfaMethod" }
                }
            },
            example: { methods: ["email", "totp", "passkey", "recovery"] }
        },
        MfaReauth: {
            type: "object",
            properties: {
                password: {
                    type: "string",
                    description:
                        "The account's password. Needed when the account has one, ignored otherwise."
                }
            }
        },
        MfaRecoveryCodes: {
            type: "array",
            minItems: MFA_RECOVERY_CODES,
            maxItems: MFA_RECOVERY_CODES,
            items: { type: "string", pattern: "^[a-z2-7]{5}-[a-z2-7]{5}$" },
            description: `${MFA_RECOVERY_CODES} single-use codes, shown only in this answer.`
        },
        PasskeyAuthenticationResponse: {
            type: "object",
            description:
                "The `toJSON()` of the credential `navigator.credentials.get()` returns (`AuthenticationResponseJSON`, as `startAuthentication()` of `@simplewebauthn/browser` returns it). The API looks the passkey up by `id` and, when the authenticator sends `response.userHandle` (optional here, required for `POST /auth/passkey`), checks it is the account's; the rest is checked by `@simplewebauthn/server`: the challenge, origin, RP ID, user verification, signature and counter.",
            required: ["id", "rawId", "type", "response", "clientExtensionResults"],
            properties: {
                id: { type: "string", description: "The credential id, base64url." },
                rawId: { type: "string" },
                type: { type: "string", const: "public-key" },
                authenticatorAttachment: { type: "string", enum: ["platform", "cross-platform"] },
                response: {
                    type: "object",
                    required: ["clientDataJSON", "authenticatorData", "signature"],
                    properties: {
                        clientDataJSON: { type: "string" },
                        authenticatorData: { type: "string" },
                        signature: { type: "string" },
                        userHandle: {
                            type: "string",
                            description: "The account's id (its 12 bytes, base64url)."
                        }
                    }
                },
                clientExtensionResults: { type: "object" }
            }
        }
    },
    responses: {
        MfaChallengeExpired: {
            ...errorResponse(
                "No live challenge: the cookie is missing or malformed (`noChallenge`), the challenge used up its tries (`triesUsedUp`) or its minutes (`expired`), or it ended otherwise (`ended`): a newer login, a logout, a password or e-mail change, a suspended account, MFA turned off, a wrong secret, a parallel request that spent the same TOTP step or recovery code, or, for a GitHub login, the account no longer linked to that GitHub account.",
                { error: Responses.Mfa.challengeExpired, reason: "noChallenge" },
                { error: Responses.Mfa.challengeExpired, reason: "triesUsedUp" },
                { error: Responses.Mfa.challengeExpired, reason: "expired" },
                { error: Responses.Mfa.challengeExpired, reason: "ended" }
            ),
            headers: setCookie(`Clears \`${mfaCookie}\`.`)
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/auth/mfa": {
        get: {
            tags: ["MFA"],
            summary: "List the challenge's methods",
            description:
                "Lists the MFA methods that can pass the login's challenge, for example after the GitHub login redirected to the site with `?mfa=required`.",
            security: [],
            parameters: [challengeCookie],
            responses: {
                "200": {
                    description: "The methods that are on, never empty.",
                    content: {
                        "application/json": { schema: { $ref: "#/components/schemas/MfaMethods" } }
                    }
                },
                "403": challengeExpired,
                "500": serverError
            }
        }
    },
    "/auth/mfa/verify": {
        post: {
            tags: ["MFA"],
            summary: "Pass the challenge",
            description: `Checks one method's proof and, when it passes, starts the session like \`POST /auth/login\`. Every checked proof uses one of the challenge's ${MFA_CHALLENGE_ATTEMPTS} tries; a malformed body uses none. A TOTP code works once and only if it's newer than the last one used. A recovery code is used up by the login it starts, which mails the account a security notice. For \`passkey\`, get the options from \`POST /auth/mfa/passkey/options\` first and send the \`toJSON()\` of \`navigator.credentials.get()\`; every passkey try uses up those options, so fetch new ones before retrying. Finishing a GitHub login also counts as a GitHub confirmation for the next ${GITHUB_REAUTH_MINUTES} minutes of account changes.`,
            security: [],
            parameters: [challengeCookie],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["method"],
                            properties: {
                                method: { $ref: "#/components/schemas/MfaMethod" },
                                code: {
                                    type: "string",
                                    minLength: 1,
                                    description: `For \`email\`: the mailed ${EMAIL_CODE_LENGTH} digits; for \`totp\`: the app's 6 digits (spaces are dropped). For \`recovery\`: a recovery code, ignoring case, spaces and dashes.`
                                },
                                response: {
                                    $ref: "#/components/schemas/PasskeyAuthenticationResponse"
                                }
                            }
                        },
                        examples: {
                            totp: { value: { method: "totp", code: "123456" } },
                            email: { value: { method: "email", code: "123456" } },
                            recovery: { value: { method: "recovery", code: "aaaaa-aaaaa" } },
                            passkey: {
                                value: {
                                    method: "passkey",
                                    response: {
                                        id: "base64url-credential-id",
                                        rawId: "base64url-credential-id",
                                        type: "public-key",
                                        response: {
                                            clientDataJSON: "base64url-client-data",
                                            authenticatorData: "base64url-authenticator-data",
                                            signature: "base64url-signature",
                                            userHandle: "base64url-user-id"
                                        },
                                        clientExtensionResults: {}
                                    }
                                }
                            }
                        }
                    }
                }
            },
            responses: {
                "200": { ...loginSucceeded, headers: loginCookies },
                "400": errorResponse(
                    "The body is malformed (no try used), or the proof is wrong (a try used). A wrong proof also answers `attemptsLeft`, the challenge's tries left after this one.",
                    Responses.invalidJson,
                    Responses.Mfa.missingMethod,
                    Responses.Mfa.methodNotOn,
                    Responses.Mfa.missingProof,
                    { error: Responses.EmailCodes.invalidCode, attemptsLeft: 3 },
                    { error: Responses.Passkeys.invalidPasskey, attemptsLeft: 3 }
                ),
                "403": challengeExpired,
                "429": verifyLimited,
                "413": requestTooLarge,
                "500": serverError
            }
        }
    },
    "/auth/mfa/verify-link": {
        post: {
            tags: ["MFA"],
            summary: "Pass the challenge with the mailed link",
            description:
                "Like `POST /auth/mfa/verify` with the token of the link `POST /auth/mfa/email` mailed (`<site>/login/mfa#token=<token>`). The link only works in the browser holding the challenge's cookie. A checked token uses a try.",
            security: [],
            parameters: [challengeCookie],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["token"],
                            properties: { token: { type: "string", minLength: 1 } }
                        },
                        example: { token: "token-from-the-mailed-link" }
                    }
                }
            },
            responses: {
                "200": { ...loginSucceeded, headers: loginCookies },
                "400": errorResponse(
                    "The body is malformed or e-mail MFA is off (no try used), or the token is wrong (a try used, with `attemptsLeft`).",
                    Responses.invalidJson,
                    Responses.Mfa.missingLinkToken,
                    Responses.Mfa.methodNotOn,
                    { error: Responses.Mfa.invalidLink, attemptsLeft: 3 }
                ),
                "403": challengeExpired,
                "429": verifyLimited,
                "413": requestTooLarge,
                "500": serverError
            }
        }
    },
    "/auth/mfa/email": {
        post: {
            tags: ["MFA"],
            summary: "Mail a login code and link",
            description: `Mails a ${EMAIL_CODE_LENGTH} digit code and a login link to the account's address, replacing any sent before for this challenge. Takes no body. A failed send keeps the earlier code and link.`,
            security: [],
            parameters: [challengeCookie],
            responses: {
                "202": messageResponse(
                    "The code and link were mailed.",
                    Responses.Mfa.emailCodeSent
                ),
                "400": errorResponse("E-mail MFA isn't on.", Responses.Mfa.methodNotOn),
                "403": challengeExpired,
                "429": limitedResponse(
                    `Within ${EMAIL_CODE_RESEND_SECONDS} seconds of the account's last code (\`resendCooldown\`, also across logins), over ${MFA_EMAILS_PER_DAY} mails in ${codeFailuresWindow} for the account (\`mfaEmailLimit\`), or after ${MAIL_SENDS_PER_IP} sent mails from this IP address in ${duration(MAIL_SENDS_WINDOW_MS)}, a count shared with registering, password resets and e-mail changes.`,
                    {
                        error: Responses.EmailCodes.resendTooSoon(EMAIL_CODE_RESEND_SECONDS),
                        reason: "resendCooldown"
                    },
                    { error: Responses.Mfa.tooManyEmails, reason: "mfaEmailLimit" },
                    Responses.tooManyEmails
                ),
                "503": {
                    ...errorResponse(
                        "The mail couldn't be sent, or the site's daily mail limit is used up (`mailBudget`, with `retryAfter`: seconds until the next UTC midnight).",
                        Responses.EmailCodes.mailFailed,
                        {
                            error: Responses.EmailCodes.mailBudgetUsedUpForAccounts,
                            retryAfter: 3600,
                            reason: "mailBudget"
                        }
                    ),
                    headers: {
                        "Retry-After": {
                            description: 'Only with `reason: "mailBudget"`.',
                            schema: { type: "integer", minimum: 1 }
                        }
                    }
                },
                "500": serverError
            }
        }
    },
    "/user/mfa/email": {
        put: {
            tags: ["MFA"],
            summary: "Turn e-mail MFA on",
            description: `Turns e-mail MFA on (also when it already was). ${reauthDescription} An account without recovery codes gets a fresh set in this answer. A change mails the account a security notice.`,
            security: [{ session: [] }],
            requestBody: reauthBody,
            responses: {
                "200": messageResponse(
                    "E-mail MFA is on. `recoveryCodes` only when the account had none left.",
                    Responses.Mfa.emailMfaOn,
                    firstRecoveryCodes
                ),
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    Responses.Mfa.missingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "409": errorResponse(
                    "The account's e-mail address isn't confirmed: a password reset or an e-mail change confirms it.",
                    Responses.Mfa.emailNotVerified
                ),
                "429": passwordChecksLimited,
                "413": requestTooLarge,
                "500": serverError
            }
        },
        delete: {
            tags: ["MFA"],
            summary: "Turn e-mail MFA off",
            description: `Turns e-mail MFA off (also when it already was) and removes a waiting challenge. With no other method on (\`totp\`), the recovery codes are removed too. ${reauthDescription} A change mails the account a security notice.`,
            security: [{ session: [] }],
            requestBody: reauthBody,
            responses: {
                "200": messageResponse("E-mail MFA is off.", Responses.Mfa.emailMfaOff),
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    Responses.Mfa.missingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "429": passwordChecksLimited,
                "413": requestTooLarge,
                "500": serverError
            }
        }
    },
    "/user/mfa/totp": {
        post: {
            tags: ["MFA"],
            summary: "Start a TOTP setup",
            description: `Makes a new TOTP secret (HMAC-SHA1, 6 digits, 30 seconds) that waits ${MFA_TOTP_SETUP_MINUTES} minutes for its first code at \`POST /user/mfa/totp/confirm\`, from this session only. It replaces a waiting setup; TOTP already on keeps its secret until the new one is confirmed. The secret is never shown again. ${reauthDescription}`,
            security: [{ session: [] }],
            requestBody: reauthBody,
            responses: {
                "200": {
                    description: "The setup waits for its first code.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["secret", "otpauthUrl"],
                                properties: {
                                    secret: {
                                        type: "string",
                                        pattern: "^[A-Z2-7]{32}$",
                                        description: "20 random bytes, base32 without padding."
                                    },
                                    otpauthUrl: {
                                        type: "string",
                                        format: "uri",
                                        description: "For a QR code."
                                    }
                                }
                            },
                            example: {
                                secret: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
                                otpauthUrl:
                                    "otpauth://totp/vb2007.hu:vb2007?secret=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH&issuer=vb2007.hu&algorithm=SHA1&digits=6&period=30"
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    Responses.Mfa.missingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "429": passwordChecksLimited,
                "413": requestTooLarge,
                "500": serverError
            }
        },
        delete: {
            tags: ["MFA"],
            summary: "Turn TOTP off",
            description: `Turns TOTP off (also when it already was) and removes a waiting setup and a waiting challenge. With no other method on (\`email\`), the recovery codes are removed too. ${reauthDescription} A change mails the account a security notice.`,
            security: [{ session: [] }],
            requestBody: reauthBody,
            responses: {
                "200": messageResponse("TOTP is off.", Responses.Mfa.totpMfaOff),
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    Responses.Mfa.missingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "429": passwordChecksLimited,
                "413": requestTooLarge,
                "500": serverError
            }
        }
    },
    "/user/mfa/totp/confirm": {
        post: {
            tags: ["MFA"],
            summary: "Confirm the TOTP setup",
            description: `Turns TOTP on with the waiting secret once a code from the app matches, replacing an earlier secret. Only the session that started the setup can confirm it, and needs no password. The setup has ${MFA_TOTP_SETUP_ATTEMPTS} tries. An account without recovery codes gets a fresh set in this answer. Mails the account a security notice. Parallel confirms that lose the race answer \`200\` when TOTP now holds the same secret, else \`400\` with \`noSetup\`, so reload the MFA status on \`noSetup\`.`,
            security: [{ session: [] }],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["code"],
                            properties: {
                                code: {
                                    type: "string",
                                    minLength: 1,
                                    description:
                                        "The app's 6 digit code (the current 30 seconds or the ones next to it; spaces are dropped)."
                                }
                            }
                        },
                        example: { code: "123456" }
                    }
                }
            },
            responses: {
                "200": messageResponse(
                    "TOTP is on. `recoveryCodes` only when the account had none left.",
                    Responses.Mfa.totpMfaOn,
                    firstRecoveryCodes
                ),
                "400": errorResponse(
                    "The body is malformed, the code is wrong (with `attemptsLeft`, the setup's tries left), or the setup is gone (with a `reason`: `setupTriesUsedUp`, `setupExpired`, or `noSetup` when none waits for this session) and a new one has to be started.",
                    Responses.invalidJson,
                    Responses.Users.missingCode,
                    { error: Responses.EmailCodes.invalidCode, attemptsLeft: 4 },
                    { error: Responses.EmailCodes.invalidCode, reason: "setupTriesUsedUp" },
                    { error: Responses.EmailCodes.invalidCode, reason: "setupExpired" },
                    { error: Responses.EmailCodes.invalidCode, reason: "noSetup" }
                ),
                "403": sessionForbiddenResponse(),
                "429": limitedResponse(
                    `After ${FAILED_ATTEMPTS_PER_ACCOUNT} wrong codes for this account, or ${FAILED_ATTEMPTS_PER_IP} from this IP address, in ${failedAttemptsWindow}, counted together with \`POST /user/email/confirm\`.`,
                    Responses.tooManyFailedAttempts
                ),
                "413": requestTooLarge,
                "500": serverError
            }
        }
    }
};
