import { UserModel, activeSessionFilter, reauthedSessionFilter } from "./users";
import { countUnclaimedTry, failureCountingClaim } from "./emailCodes";
import { MFA_TOTP_SETUP_ATTEMPTS } from "../constants/limits";

export interface MfaTotpSetup {
    secret: string;
    session: string;
    expiresAt: Date;
    attempts: number;
}

type ReauthedSession = ReturnType<typeof reauthedSessionFilter>;

export const claimTotpStep = (id: string, secret: string, step: number) =>
    UserModel.updateOne(
        {
            _id: id,
            "authentication.mfaTotpSecret": { $eq: secret },
            "authentication.mfaTotpLastStep": { $not: { $gte: step } }
        },
        { $set: { "authentication.mfaTotpLastStep": step } }
    );

export const setMfaTotpSetup = (reauthed: ReauthedSession, setup: MfaTotpSetup) =>
    UserModel.updateOne(reauthed, { $set: { "authentication.mfaTotpSetup": setup } });

export const claimMfaTotpSetupTry = (id: string, sessionHash: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.mfaTotpSetup",
        "authentication.mfaFailures"
    );

    return UserModel.findOneAndUpdate(
        {
            _id: id,
            "authentication.mfaTotpSetup.session": { $eq: sessionHash },
            "authentication.mfaTotpSetup.expiresAt": { $gt: new Date() },
            "authentication.mfaTotpSetup.attempts": { $lt: MFA_TOTP_SETUP_ATTEMPTS },
            ...belowCap
        },
        countGuess,
        { new: true }
    )
        .select("+authentication.mfaTotpSetup +authentication.mfaFailures")
        .lean();
};

export const countMfaTotpSetupFailure = (id: string) =>
    UserModel.findOneAndUpdate({ _id: id }, countUnclaimedTry("authentication.mfaFailures"), {
        new: false
    })
        .select("+authentication.mfaFailures")
        .lean();

export const enableMfaTotp = (
    id: string,
    sessionToken: string,
    setup: Pick<MfaTotpSetup, "secret" | "session">,
    step: number
) =>
    UserModel.updateOne(
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
        }
    );

export const disableMfaTotp = (reauthed: ReauthedSession, storedPaths: string[]) =>
    UserModel.updateOne(reauthed, {
        $unset: Object.fromEntries(
            ["authentication.mfaChallenge", ...storedPaths].map((path) => [path, 1])
        )
    });
