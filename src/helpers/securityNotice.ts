import { Emails } from "../constants/emails";
import { sendMail } from "./mail";

export const mailSecurityNotice = async (
    user: { email: string; username: string },
    change: string
): Promise<void> => {
    try {
        await sendMail({
            to: user.email,
            ...Emails.securityNotice(user.username, change, new Date())
        });
    } catch (error) {
        console.error(error);
    }
};
