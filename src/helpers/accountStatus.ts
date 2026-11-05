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
    emailChange?: { email: string; expiresAt: Date };
}

export const toAccountStatus = (
    authentication: AccountAuthentication | undefined
): AccountStatus => ({
    hasPassword: Boolean(authentication?.password),
    emailVerified: Boolean(authentication?.emailVerifiedAt),
    pendingEmail:
        authentication?.emailChange?.expiresAt > new Date()
            ? authentication.emailChange.email
            : null
});
