import { EMAIL_CODE_MAX_ATTEMPTS } from "../constants/limits";

export const accountStatusFields: string =
    "+authentication.password +authentication.emailVerifiedAt +authentication.emailChange +authentication.mfaEmail +authentication.mfaTotpSecret +authentication.passkeys";

interface AccountStatus {
    hasPassword: boolean;
    emailVerified: boolean;
    pendingEmail: string | null;
    mfa: { email: boolean; totp: boolean; passkeys: number };
}

interface AccountAuthentication {
    password?: string;
    emailVerifiedAt?: Date;
    emailChange?: { email: string; expiresAt: Date; attempts?: number };
    mfaEmail?: boolean;
    mfaTotpSecret?: string;
    passkeys?: unknown[];
}

const isConfirmable = (emailChange: AccountAuthentication["emailChange"]): boolean =>
    emailChange?.expiresAt > new Date() && (emailChange.attempts ?? 0) < EMAIL_CODE_MAX_ATTEMPTS;

export const toAccountStatus = (
    authentication: AccountAuthentication | undefined
): AccountStatus => ({
    hasPassword: Boolean(authentication?.password),
    emailVerified: Boolean(authentication?.emailVerifiedAt),
    pendingEmail: isConfirmable(authentication?.emailChange)
        ? authentication.emailChange.email
        : null,
    mfa: {
        email: Boolean(authentication?.mfaEmail),
        totp: Boolean(authentication?.mfaTotpSecret),
        passkeys: authentication?.passkeys?.length ?? 0
    }
});
