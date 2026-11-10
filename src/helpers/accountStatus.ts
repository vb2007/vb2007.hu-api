import { EMAIL_CODE_MAX_ATTEMPTS } from "../constants/limits";

export const accountStatusFields: string =
    "+authentication.password +authentication.emailVerifiedAt +authentication.emailChange";

interface AccountStatus {
    hasPassword: boolean;
    emailVerified: boolean;
    pendingEmail: string | null;
}

interface AccountAuthentication {
    password?: string;
    emailVerifiedAt?: Date;
    emailChange?: { email: string; expiresAt: Date; attempts?: number };
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
        : null
});
