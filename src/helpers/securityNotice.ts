import { Emails } from "../constants/emails";
import { SECURITY_NOTICES_PER_DAY } from "../constants/limits";
import { claimSecurityNotice } from "../database/mfa";
import { sendMail } from "./mail";

interface NoticeUser {
    _id: unknown;
    email: string;
    username: string;
}

export const mailSecurityNotice = async (user: NoticeUser, change: string): Promise<void> => {
    try {
        const { matchedCount } = await claimSecurityNotice(String(user._id));

        if (matchedCount === 0) {
            return console.warn(
                `Security notice not sent: ${SECURITY_NOTICES_PER_DAY} a day per account used up`
            );
        }

        await sendMail({
            to: user.email,
            ...Emails.securityNotice(user.username, change, new Date())
        });
    } catch (error) {
        console.error(error);
    }
};
