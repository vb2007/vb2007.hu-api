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

    static passwordResetCode(username: string, code: string, validMinutes: number): MailContent {
        return {
            subject: `${code} is your vb2007.hu password reset code`,
            text: [
                `Hi ${username},`,
                "",
                `Your code to reset your vb2007.hu password: ${code}`,
                "",
                `It expires in ${validMinutes} minutes. If you didn't ask for it, you can ignore this e-mail: your password stays the same.`
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
}
