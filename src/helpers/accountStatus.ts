import { EMAIL_CODE_MAX_ATTEMPTS } from "../constants/limits";

export const accountStatusFields: string =
    "+authentication.password +authentication.emailVerifiedAt +authentication.emailChange +authentication.mfaEmail";

interface AccountStatus {
    hasPassword: boolean;
    emailVerified: boolean;
    pendingEmail: string | null;
    mfa: { email: boolean };
}

interface AccountAuthentication {
    password?: string;
    emailVerifiedAt?: Date;
    emailChange?: { email: string; expiresAt: Date; attempts?: number };
    mfaEmail?: boolean;
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
    mfa: { email: Boolean(authentication?.mfaEmail) }
});
