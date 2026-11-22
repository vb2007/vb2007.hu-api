import type { DocsModule } from "../openapi";
import { errorResponse, sessionForbiddenResponse } from "../components";
import { Responses } from "../../constants/responses";
import {
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    PASSKEYS_PER_ACCOUNT,
    PASSKEY_CHALLENGE_MINUTES,
    PASSKEY_NAME_MAX_LENGTH,
    PASSKEY_OPTIONS_PER_IP
} from "../../constants/limits";
import {
    bodyResponses,
    limitedResponse,
    messageResponse,
    passwordChecksLimited,
    reauthBody,
    reauthCheckDescription,
    reauthDescription,
    reauthErrors,
    reauthMissingPassword,
    serverError
} from "./mfa";

const optionsLimitDescription: string = `After ${PASSKEY_OPTIONS_PER_IP} options requests from this IP address in a minute, counted across the three passkey options operations.`;

const optionsLimited = limitedResponse(optionsLimitDescription, Responses.Passkeys.tooManyRequests);

const nameErrors: string[] = [
    Responses.Passkeys.missingName,
    Responses.Passkeys.nameTooLong,
    Responses.Passkeys.nameInvalidCharacters
];

const nameProperty = {
    type: "string",
    minLength: 1,
    maxLength: PASSKEY_NAME_MAX_LENGTH,
    description: `A label, trimmed, 1 to ${PASSKEY_NAME_MAX_LENGTH} characters, without control, format, line or paragraph separator characters (emoji joiners and tags are allowed).`
};

const idParameter = {
    name: "id",
    in: "path",
    required: true,
    description:
        "The passkey's credential id from `GET /user/passkeys`. A malformed one, or one not on this account, answers `404`.",
    schema: { type: "string", pattern: "^[\\w-]{1,1364}$" }
};

const notFound = errorResponse(
    "This account has no passkey with that id.",
    Responses.Passkeys.passkeyNotFound
);

const requestOptionsExample = {
    rpId: "vb2007.hu",
    challenge: "a0w8Gtq6KWx_3yt0BkUPH_DjvzxDEV-q8PUOoH32qcU",
    timeout: PASSKEY_CHALLENGE_MINUTES * 60 * 1000,
    userVerification: "required"
};

const challengeCookie = (name: string, ceremony: string) => ({
    "Set-Cookie": {
        description: `Sets \`${name}\` (\`HttpOnly\`, \`Secure\`, \`SameSite=Lax\`, ${PASSKEY_CHALLENGE_MINUTES} minutes), which holds this ${ceremony}'s challenge.`,
        schema: { type: "string" }
    }
});

const challengeCookieParameter = (name: string, from: string) => ({
    name,
    in: "cookie",
    required: true,
    description: `Set by \`${from}\`. It's used up by the first request that checks it, whether the passkey verifies or not, and cleared.`,
    schema: { type: "string", pattern: "^[\\w-]{43}$" }
});

export const tags: DocsModule["tags"] = [
    {
        name: "passkeys",
        description: `WebAuthn passkeys: register, list, rename and delete them, and log in with one, which skips MFA. The relying party is the site's hostname and its origin the only accepted one, only the \`none\` attestation is asked for, user verification is required, and the key types are Ed25519, ES256 and RS256. An account can have ${PASSKEYS_PER_ACCOUNT}.`
    }
];

export const components: DocsModule["components"] = {
    schemas: {
        Passkey: {
            type: "object",
            required: ["id", "name", "createdAt", "lastUsedAt"],
            properties: {
                id: { type: "string", description: "The credential id, base64url." },
                name: { type: "string" },
                createdAt: { type: "string", format: "date-time" },
                lastUsedAt: {
                    type: ["string", "null"],
                    format: "date-time",
                    description: "`null` until the passkey's first login."
                }
            },
            example: {
                id: "sNS8f-AIJjLwqvx7mfxqHg",
                name: "Laptop",
                createdAt: "2026-11-22T19:18:35.856Z",
                lastUsedAt: null
            }
        },
        PasskeyRequestOptions: {
            type: "object",
            description:
                "`PublicKeyCredentialRequestOptionsJSON`, for `PublicKeyCredential.parseRequestOptionsFromJSON()` or `startAuthentication()` of `@simplewebauthn/browser`.",
            required: ["challenge", "rpId", "timeout", "userVerification"],
            properties: {
                challenge: { type: "string" },
                rpId: { type: "string" },
                timeout: { type: "integer" },
                userVerification: { type: "string", const: "required" },
                allowCredentials: {
                    type: "array",
                    description: "Only for the MFA second step: the account's passkeys.",
                    items: {
                        type: "object",
                        required: ["id", "type"],
                        properties: {
                            id: { type: "string" },
                            type: { type: "string", const: "public-key" },
                            transports: { type: "array", items: { type: "string" } }
                        }
                    }
                }
            }
        }
    }
};

export const paths: DocsModule["paths"] = {
    "/user/passkeys/options": {
        post: {
            tags: ["passkeys"],
            summary: "Start a passkey registration",
            description: `Answers WebAuthn creation options for a discoverable credential with user verification, listing the account's passkeys in \`excludeCredentials\`. Pass them to \`navigator.credentials.create()\` and send its \`toJSON()\` to \`POST /user/passkeys\` with the cookie. ${reauthCheckDescription}`,
            security: [{ session: [] }],
            requestBody: reauthBody,
            responses: {
                "200": {
                    description: `\`PublicKeyCredentialCreationOptionsJSON\`, for \`PublicKeyCredential.parseCreationOptionsFromJSON()\` or \`startRegistration()\` of \`@simplewebauthn/browser\`. The challenge is valid for ${PASSKEY_CHALLENGE_MINUTES} minutes.`,
                    headers: challengeCookie("__Host-VB-PASSKEY-REG", "registration"),
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: [
                                    "challenge",
                                    "rp",
                                    "user",
                                    "pubKeyCredParams",
                                    "timeout",
                                    "attestation",
                                    "excludeCredentials",
                                    "authenticatorSelection"
                                ],
                                properties: {
                                    challenge: { type: "string" },
                                    rp: {
                                        type: "object",
                                        properties: {
                                            name: { type: "string" },
                                            id: { type: "string" }
                                        }
                                    },
                                    user: {
                                        type: "object",
                                        properties: {
                                            id: {
                                                type: "string",
                                                description:
                                                    "The user handle: the account's id (its 12 bytes, base64url)."
                                            },
                                            name: { type: "string" },
                                            displayName: { type: "string" }
                                        }
                                    },
                                    pubKeyCredParams: { type: "array", items: { type: "object" } },
                                    timeout: { type: "integer" },
                                    attestation: { type: "string", const: "none" },
                                    excludeCredentials: {
                                        type: "array",
                                        items: { type: "object" }
                                    },
                                    authenticatorSelection: { type: "object" },
                                    extensions: { type: "object" },
                                    hints: { type: "array", items: { type: "string" } }
                                }
                            },
                            example: {
                                challenge: "EhrF996_DZiCYbvT-GuevNhEVozSuQF2Zded916p7JE",
                                rp: { name: "vb2007.hu", id: "vb2007.hu" },
                                user: { id: "awNACvkoJLH8_g0M", name: "vb2007", displayName: "" },
                                pubKeyCredParams: [
                                    { alg: -8, type: "public-key" },
                                    { alg: -7, type: "public-key" },
                                    { alg: -257, type: "public-key" }
                                ],
                                timeout: PASSKEY_CHALLENGE_MINUTES * 60 * 1000,
                                attestation: "none",
                                excludeCredentials: [],
                                authenticatorSelection: {
                                    residentKey: "required",
                                    requireResidentKey: true,
                                    userVerification: "required"
                                },
                                extensions: { credProps: true },
                                hints: []
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    reauthMissingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "409": errorResponse(
                    `The account already has ${PASSKEYS_PER_ACCOUNT} passkeys.`,
                    Responses.Passkeys.tooManyPasskeys
                ),
                "429": limitedResponse(
                    `${optionsLimitDescription} Or after ${FAILED_ATTEMPTS_PER_ACCOUNT} wrong passwords for this account, or ${FAILED_ATTEMPTS_PER_IP} from this IP address, in ${FAILED_ATTEMPTS_WINDOW_MS / 60000} minutes.`,
                    Responses.Passkeys.tooManyRequests,
                    Responses.tooManyFailedAttempts
                ),
                ...bodyResponses
            }
        }
    },
    "/user/passkeys": {
        post: {
            tags: ["passkeys"],
            summary: "Finish a passkey registration",
            description:
                "Verifies the new credential against the registration's challenge and adds it to the account, while the session that sends it is still live. The `name` is checked before the challenge, so a bad one doesn't use it up. Mails the account a security notice with the name.",
            security: [{ session: [] }],
            parameters: [
                challengeCookieParameter("__Host-VB-PASSKEY-REG", "POST /user/passkeys/options")
            ],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["name", "response"],
                            properties: {
                                name: nameProperty,
                                response: {
                                    type: "object",
                                    description:
                                        "The `toJSON()` of the credential `navigator.credentials.create()` returns (`RegistrationResponseJSON`, as `startRegistration()` of `@simplewebauthn/browser` returns it), checked by `@simplewebauthn/server`.",
                                    required: [
                                        "id",
                                        "rawId",
                                        "type",
                                        "response",
                                        "clientExtensionResults"
                                    ],
                                    properties: {
                                        id: { type: "string" },
                                        rawId: { type: "string" },
                                        type: { type: "string", const: "public-key" },
                                        authenticatorAttachment: { type: "string" },
                                        response: {
                                            type: "object",
                                            required: ["clientDataJSON", "attestationObject"],
                                            properties: {
                                                clientDataJSON: { type: "string" },
                                                attestationObject: { type: "string" },
                                                transports: {
                                                    type: "array",
                                                    description:
                                                        "Stored, keeping only `ble`, `cable`, `hybrid`, `internal`, `nfc`, `smart-card` and `usb`.",
                                                    items: { type: "string" }
                                                }
                                            }
                                        },
                                        clientExtensionResults: { type: "object" }
                                    }
                                }
                            }
                        },
                        example: {
                            name: "Laptop",
                            response: {
                                id: "sNS8f-AIJjLwqvx7mfxqHg",
                                rawId: "sNS8f-AIJjLwqvx7mfxqHg",
                                type: "public-key",
                                response: {
                                    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIi…",
                                    attestationObject: "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YV…",
                                    transports: ["internal", "hybrid"]
                                },
                                clientExtensionResults: {}
                            }
                        }
                    }
                }
            },
            responses: {
                "201": {
                    description: "The passkey was added.",
                    headers: {
                        "Set-Cookie": {
                            description: "Clears `__Host-VB-PASSKEY-REG`.",
                            schema: { type: "string" }
                        }
                    },
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["message", "passkey"],
                                properties: {
                                    message: { type: "string" },
                                    passkey: { $ref: "#/components/schemas/Passkey" }
                                }
                            },
                            example: {
                                message: Responses.Passkeys.passkeyAddedSuccess,
                                passkey: {
                                    id: "sNS8f-AIJjLwqvx7mfxqHg",
                                    name: "Laptop",
                                    createdAt: "2026-11-22T19:18:35.856Z",
                                    lastUsedAt: null
                                }
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "The name or `response` is malformed, there's no usable registration challenge (no cookie, or it expired, was used or belongs to another account or ceremony), or the credential doesn't verify.",
                    Responses.invalidJson,
                    ...nameErrors,
                    Responses.Passkeys.missingResponse,
                    Responses.Passkeys.challengeExpired,
                    Responses.Passkeys.invalidRegistration
                ),
                "403": sessionForbiddenResponse(),
                "409": errorResponse(
                    `This or another account already has the credential, or the account reached ${PASSKEYS_PER_ACCOUNT} passkeys meanwhile. A session that ended meanwhile answers the cap's error too.`,
                    Responses.Passkeys.alreadyRegistered,
                    Responses.Passkeys.tooManyPasskeys
                ),
                ...bodyResponses
            }
        },
        get: {
            tags: ["passkeys"],
            summary: "List the passkeys",
            description: "Lists the account's passkeys, without key material.",
            security: [{ session: [] }],
            responses: {
                "200": {
                    description: "The account's passkeys, oldest first.",
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["passkeys"],
                                properties: {
                                    passkeys: {
                                        type: "array",
                                        maxItems: PASSKEYS_PER_ACCOUNT,
                                        items: { $ref: "#/components/schemas/Passkey" }
                                    }
                                }
                            }
                        }
                    }
                },
                "403": sessionForbiddenResponse(),
                ...serverError
            }
        }
    },
    "/user/passkeys/{id}": {
        patch: {
            tags: ["passkeys"],
            summary: "Rename a passkey",
            description:
                "Renames one of the account's passkeys. Needs no password, since the name is only a label. The name is checked before the id.",
            security: [{ session: [] }],
            parameters: [idParameter],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["name"],
                            properties: { name: nameProperty }
                        },
                        example: { name: "Phone" }
                    }
                }
            },
            responses: {
                "200": messageResponse(
                    "The passkey was renamed.",
                    Responses.Passkeys.passkeyRenamedSuccess
                ),
                "400": errorResponse(
                    "The body or the name is malformed.",
                    Responses.invalidJson,
                    ...nameErrors
                ),
                "403": sessionForbiddenResponse(),
                "404": notFound,
                ...bodyResponses
            }
        },
        delete: {
            tags: ["passkeys"],
            summary: "Delete a passkey",
            description: `Deletes one of the account's passkeys; deleting the last one takes \`passkey\` off the MFA methods. The browser or password manager keeps its copy until the user removes it there. The owner is checked before the id. ${reauthDescription} Mails the account a security notice.`,
            security: [{ session: [] }],
            parameters: [idParameter],
            requestBody: reauthBody,
            responses: {
                "200": messageResponse(
                    "The passkey was deleted.",
                    Responses.Passkeys.passkeyDeletedSuccess
                ),
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    reauthMissingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "404": notFound,
                "429": passwordChecksLimited,
                ...bodyResponses
            }
        }
    },
    "/auth/passkey/options": {
        post: {
            tags: ["passkeys"],
            summary: "Start a passkey login",
            description: `Answers WebAuthn request options with user verification and no \`allowCredentials\`, so the browser offers every passkey it has for the site. Takes no body and no session. Pass them to \`navigator.credentials.get()\` and send its \`toJSON()\` to \`POST /auth/passkey\` with the cookie. A login started elsewhere doesn't end a registration in progress, since each has its own cookie.`,
            security: [],
            responses: {
                "200": {
                    description: `The options. The challenge is valid for ${PASSKEY_CHALLENGE_MINUTES} minutes.`,
                    headers: challengeCookie("__Host-VB-PASSKEY-LOGIN", "login"),
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/PasskeyRequestOptions" },
                            example: requestOptionsExample
                        }
                    }
                },
                "429": optionsLimited,
                ...serverError
            }
        }
    },
    "/auth/passkey": {
        post: {
            tags: ["passkeys"],
            summary: "Log in with a passkey",
            description:
                "Checks the assertion against the login's challenge and the stored passkey (a counter that didn't grow is refused as a possible clone), stores the new counter and last use, and starts a session like `POST /auth/login`: the account's other session ends and a waiting MFA challenge is removed. Every MFA method is skipped, since a passkey with user verification is already two factors. Sets no `VB-DEVICE` cookie.",
            security: [],
            parameters: [
                challengeCookieParameter("__Host-VB-PASSKEY-LOGIN", "POST /auth/passkey/options")
            ],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["response"],
                            properties: {
                                response: {
                                    $ref: "#/components/schemas/PasskeyAuthenticationResponse"
                                }
                            }
                        },
                        example: {
                            response: {
                                id: "sNS8f-AIJjLwqvx7mfxqHg",
                                rawId: "sNS8f-AIJjLwqvx7mfxqHg",
                                type: "public-key",
                                response: {
                                    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0Ii…",
                                    authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4…",
                                    signature: "MEUCIQ…",
                                    userHandle: "awNACvkoJLH8_g0M"
                                },
                                clientExtensionResults: {}
                            }
                        }
                    }
                }
            },
            responses: {
                "200": {
                    ...messageResponse(
                        "Logged in.",
                        Responses.Authentication.loginSuccess("vb2007")
                    ),
                    headers: {
                        "Set-Cookie": {
                            description:
                                "Sets `__Host-VB-AUTH` (the session) and clears `__Host-VB-PASSKEY-LOGIN`.",
                            schema: { type: "string" }
                        }
                    }
                },
                "400": errorResponse(
                    "The body is malformed or `response` isn't an object.",
                    Responses.invalidJson,
                    Responses.Passkeys.missingResponse
                ),
                "403": errorResponse(
                    "The passkey couldn't be verified (no or a used-up challenge, an unknown or deleted credential, a wrong user handle, origin, RP ID or signature, no user verification, a counter that went back), or it verified but the account is suspended (nothing is stored then).",
                    Responses.Passkeys.invalidPasskey,
                    Responses.Authentication.accountSuspended
                ),
                "429": limitedResponse(
                    `After ${FAILED_ATTEMPTS_PER_IP} refused logins (\`403\`) from this IP address in ${FAILED_ATTEMPTS_WINDOW_MS / 60000} minutes.`,
                    Responses.tooManyFailedAttempts
                ),
                ...bodyResponses
            }
        }
    },
    "/auth/mfa/passkey/options": {
        post: {
            tags: ["mfa"],
            summary: "Start the MFA passkey step",
            description: `Answers WebAuthn request options for the login's challenge, with user verification and \`allowCredentials\` listing the account's passkeys. Takes no body and sets no cookie: the WebAuthn challenge is bound to the MFA challenge, valid for ${PASSKEY_CHALLENGE_MINUTES} minutes, and a newer options request or login replaces it. Pass the options to \`navigator.credentials.get()\` and send its \`toJSON()\` to \`POST /auth/mfa/verify\` with \`method: "passkey"\`.`,
            security: [],
            parameters: [{ $ref: "#/components/parameters/MfaChallengeCookie" }],
            responses: {
                "200": {
                    description: "The options.",
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/PasskeyRequestOptions" },
                            example: {
                                ...requestOptionsExample,
                                allowCredentials: [
                                    {
                                        id: "sNS8f-AIJjLwqvx7mfxqHg",
                                        transports: ["hybrid", "internal"],
                                        type: "public-key"
                                    }
                                ]
                            }
                        }
                    }
                },
                "400": errorResponse(
                    "`passkey` isn't among the challenge's methods: the account has no passkey.",
                    Responses.Mfa.methodNotOn
                ),
                "403": { $ref: "#/components/responses/MfaChallengeExpired" },
                "429": optionsLimited,
                ...serverError
            }
        }
    }
};
