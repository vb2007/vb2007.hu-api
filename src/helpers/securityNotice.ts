import { Emails } from "../constants/emails";
import { SECURITY_NOTICES_PER_DAY } from "../constants/limits";
import { claimSecurityNotice } from "../database/mfa";
import { sendMail } from "./mail";
import { trackPendingWork } from "./pendingWork";

interface NoticeUser {
    _id: string;
    email: string;
    username: string;
}

const sendSecurityNotice = async (
    user: NoticeUser,
    change: string,
    login: boolean,
    claimed: boolean = false
): Promise<void> => {
    try {
        if (!claimed && !(await claimSecurityNotice(user._id))) {
            return console.warn(
                `Security notice not sent: ${SECURITY_NOTICES_PER_DAY} a day per account used up`
            );
        }

        await sendMail({
            to: user.email,
            ...Emails.securityNotice(user.username, change, new Date(), login),
            securityNotice: true
        });
    } catch (error) {
        console.error(error);
    }
};

export const claimSecurityNoticeSlot = async (id: string): Promise<Date | null> =>
    (await claimSecurityNotice(id))?.authentication?.securityNotices?.since ?? null;

export const mailClaimedSecurityNotice = (user: NoticeUser, change: string): Promise<void> =>
    trackPendingWork(sendSecurityNotice(user, change, false, true));

export const mailSecurityNotice = (
    user: NoticeUser,
    change: string,
    login: boolean = false
): Promise<void> => trackPendingWork(sendSecurityNotice(user, change, login));
