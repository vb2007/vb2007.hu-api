export interface MailContent {
    subject: string;
    text: string;
}

export class Emails {
    static registrationCode(code: string, validMinutes: number): MailContent {
        return {
            subject: `${code} is your vb2007.hu confirmation code`,
            text: [
                "Hi,",
                "",
                `Your code to finish registering on vb2007.hu: ${code}`,
                "",
                `It expires in ${validMinutes} minutes. If you didn't register, you can ignore this e-mail.`
            ].join("\n")
        };
    }

    static passwordResetCode(
        username: string,
        code: string,
        link: string,
        validMinutes: number
    ): MailContent {
        return {
            subject: `${code} is your vb2007.hu password reset code`,
            text: [
                `Hi ${username},`,
                "",
                `Your code to reset your vb2007.hu password: ${code}`,
                "",
                "Or open this link to set a new password without the code:",
                link,
                "",
                `Both expire in ${validMinutes} minutes. If you didn't ask for it, you can ignore this e-mail: your password stays the same.`
            ].join("\n")
        };
    }

    static emailChangeCode(username: string, code: string, validMinutes: number): MailContent {
        return {
            subject: `${code} is your vb2007.hu e-mail change code`,
            text: [
                `Hi ${username},`,
                "",
                `Your code to use this address for your vb2007.hu account: ${code}`,
                "",
                `It expires in ${validMinutes} minutes. If you didn't ask for it, you can ignore this e-mail: the account keeps its current address.`
            ].join("\n")
        };
    }

    static emailChanged(username: string, newEmail: string): MailContent {
        return {
            subject: "Your vb2007.hu e-mail address was changed",
            text: [
                `Hi ${username},`,
                "",
                `Your vb2007.hu account's e-mail address was changed to ${newEmail}, so mail for the account goes there from now on.`,
                "",
                "If it wasn't you, someone else knows your password: contact the site's admin."
            ].join("\n")
        };
    }

    static passwordChanged(username: string): MailContent {
        return {
            subject: "Your vb2007.hu password was changed",
            text: [
                `Hi ${username},`,
                "",
                "Your vb2007.hu password was reset with a code or link mailed to this address, and every session was logged out.",
                "",
                "If it wasn't you, someone else can read this mailbox: secure it, reset your password again and contact the site's admin."
            ].join("\n")
        };
    }

    static mfaEmailCode(
        username: string,
        code: string,
        link: string,
        validMinutes: number
    ): MailContent {
        return {
            subject: `${code} is your vb2007.hu login code`,
            text: [
                `Hi ${username},`,
                "",
                `Your code to finish logging in to vb2007.hu: ${code}`,
                "",
                "Or open this link in the browser you're logging in with:",
                link,
                "",
                `Both expire within ${validMinutes} minutes. If you didn't just log in, someone else got past your password or GitHub login: secure them.`
            ].join("\n")
        };
    }

    static securityNotice(username: string, change: string, at: Date): MailContent {
        return {
            subject: "Your vb2007.hu account's security settings changed",
            text: [
                `Hi ${username},`,
                "",
                `${change} on ${at.toUTCString()}.`,
                "",
                "If it wasn't you, someone else has access to your account: reset your password, remove any passkeys or MFA settings you don't recognise and contact the site's admin."
            ].join("\n")
        };
    }
}

export const SecurityChanges = {
    passkeyAdded: (name: string): string =>
        `A passkey named ${JSON.stringify(name)} was added to your vb2007.hu account`,
    passkeyDeleted: "A passkey was deleted from your vb2007.hu account",
    emailMfaOn: "E-mail MFA was turned on for your vb2007.hu account",
    emailMfaOff: "E-mail MFA was turned off for your vb2007.hu account",
    totpMfaOn: "TOTP MFA (an authenticator app) was turned on for your vb2007.hu account",
    totpMfaOff: "TOTP MFA (an authenticator app) was turned off for your vb2007.hu account",
    mfaReset: "Your vb2007.hu account's MFA was reset by the site's admin",
    recoveryCodesReplaced:
        "New MFA recovery codes were generated for your vb2007.hu account, and the old ones no longer work"
};
