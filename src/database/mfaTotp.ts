import { UserModel, activeSessionFilter, reauthedSessionFilter } from "./users";
import { MFA_TOTP_SETUP_ATTEMPTS } from "../constants/limits";

export interface MfaTotpSetup {
    secret: string;
    session: string;
    expiresAt: Date;
    attempts: number;
}

type ReauthedSession = ReturnType<typeof reauthedSessionFilter>;

export const setMfaTotpSetup = (reauthed: ReauthedSession, setup: MfaTotpSetup) =>
    UserModel.updateOne(reauthed, { $set: { "authentication.mfaTotpSetup": setup } });

export const claimMfaTotpSetupTry = (id: string, sessionHash: string) =>
    UserModel.findOneAndUpdate(
        {
            _id: id,
            "authentication.mfaTotpSetup.session": { $eq: sessionHash },
            "authentication.mfaTotpSetup.expiresAt": { $gt: new Date() },
            "authentication.mfaTotpSetup.attempts": { $lt: MFA_TOTP_SETUP_ATTEMPTS }
        },
        { $inc: { "authentication.mfaTotpSetup.attempts": 1 } },
        { new: true }
    )
        .select("+authentication.mfaTotpSetup")
        .lean();

export const enableMfaTotp = (
    id: string,
    sessionToken: string,
    setup: Pick<MfaTotpSetup, "secret" | "session">,
    step: number
) =>
    UserModel.findOneAndUpdate(
        {
            _id: id,
            ...activeSessionFilter(sessionToken),
            "authentication.mfaTotpSetup.secret": { $eq: setup.secret },
            "authentication.mfaTotpSetup.session": { $eq: setup.session }
        },
        {
            $set: {
                "authentication.mfaTotpSecret": setup.secret,
                "authentication.mfaTotpLastStep": step
            },
            $unset: { "authentication.mfaTotpSetup": 1 }
        },
        { new: false }
    )
        .select("+authentication.mfaTotpSecret")
        .lean();
