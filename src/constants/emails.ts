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
}
