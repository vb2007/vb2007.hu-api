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
}
