import type { DocsModule } from "../openapi";
import { errorResponse, sessionForbiddenResponse } from "../components";
import { Responses } from "../../constants/responses";
import { MFA_RECOVERY_CODES } from "../../constants/limits";
import {
    bodyResponses,
    messageResponse,
    passwordChecksLimited,
    reauthBody,
    reauthDescription,
    reauthErrors,
    reauthMissingPassword,
    recoveryCodesExample
} from "./mfa";

export const paths: DocsModule["paths"] = {
    "/user/mfa/recovery-codes": {
        post: {
            tags: ["mfa"],
            summary: "Replace the recovery codes",
            description: `Makes ${MFA_RECOVERY_CODES} new single-use recovery codes, and the earlier ones stop working. They pass the login's challenge with \`POST /auth/mfa/verify\` and \`method: "recovery"\` when the second step can't be done otherwise. ${reauthDescription} Mails the account a security notice.`,
            security: [{ session: [] }],
            requestBody: reauthBody,
            responses: {
                "200": messageResponse(
                    "The new codes, shown only here.",
                    Responses.Mfa.recoveryCodesReplaced,
                    {
                        properties: {
                            recoveryCodes: { $ref: "#/components/schemas/MfaRecoveryCodes" }
                        },
                        example: { recoveryCodes: recoveryCodesExample },
                        required: ["recoveryCodes"]
                    }
                ),
                "400": errorResponse(
                    "The body is malformed or the password is missing.",
                    Responses.invalidJson,
                    reauthMissingPassword
                ),
                "403": sessionForbiddenResponse(...reauthErrors),
                "409": errorResponse(
                    "Neither e-mail MFA nor TOTP is on: recovery codes only work alongside one.",
                    Responses.Mfa.noMfaMethodOn
                ),
                "429": passwordChecksLimited,
                ...bodyResponses
            }
        }
    }
};
