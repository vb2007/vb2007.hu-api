import { ExpiringHash, UserModel } from "./users";
import { failureCountingClaim } from "./emailCodes";
import { MFA_CHALLENGE_ATTEMPTS } from "../constants/limits";

export interface MfaGithubLogin {
    id: string;
    login: string;
}

export interface MfaEmailCode {
    hash: string;
    linkHash: string;
}

export interface MfaChallenge {
    hash: string;
    expiresAt: Date;
    attempts: number;
    github?: MfaGithubLogin;
    email?: MfaEmailCode;
}

const challengeFields: string = "+authentication.mfaChallenge +authentication.mfaEmailSentAt";

const liveChallenge = (id: string, hash: string) => ({
    _id: id,
    suspendedAt: null as Date | null,
    "authentication.mfaChallenge.hash": { $eq: hash },
    "authentication.mfaChallenge.expiresAt": { $gt: new Date() },
    "authentication.mfaChallenge.attempts": { $lt: MFA_CHALLENGE_ATTEMPTS }
});

export const setMfaChallenge = (id: string, challenge: MfaChallenge) =>
    UserModel.updateOne(
        { _id: id, suspendedAt: null },
        { $set: { "authentication.mfaChallenge": challenge } }
    );

export const getMfaChallengeUser = (id: string, hash: string, fields: string) =>
    UserModel.findOne(liveChallenge(id, hash)).select(`${challengeFields} ${fields}`).lean();

export const dropMfaChallenge = (id: string, hash: string) =>
    UserModel.updateOne(
        { _id: id, "authentication.mfaChallenge.hash": { $eq: hash } },
        { $unset: { "authentication.mfaChallenge": 1 } }
    );

export const claimMfaTry = (id: string, hash: string, fields: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.mfaChallenge",
        "authentication.mfaFailures"
    );

    return UserModel.findOneAndUpdate({ ...liveChallenge(id, hash), ...belowCap }, countGuess, {
        new: true
    })
        .select(`${challengeFields} +authentication.mfaFailures ${fields}`)
        .lean();
};

export const uncountMfaFailure = (id: string, since: Date) =>
    UserModel.updateOne(
        {
            _id: id,
            "authentication.mfaFailures.since": { $eq: since },
            "authentication.mfaFailures.count": { $gt: 0 }
        },
        { $inc: { "authentication.mfaFailures.count": -1 } }
    );

export const startMfaSession = (
    id: string,
    hash: string,
    session: ExpiringHash,
    github: MfaGithubLogin | undefined
) =>
    UserModel.findOneAndUpdate(
        {
            _id: id,
            suspendedAt: null,
            "authentication.mfaChallenge.hash": { $eq: hash },
            "authentication.mfaChallenge.expiresAt": { $gt: new Date() },
            ...(github && { githubId: { $eq: github.id } })
        },
        {
            $set: {
                "authentication.sessionToken": session.hash,
                "authentication.sessionExpiresAt": session.expiresAt,
                ...(github && {
                    githubLogin: github.login,
                    "authentication.githubVerifiedAt": new Date()
                })
            },
            $unset: { "authentication.mfaChallenge": 1 }
        },
        { new: true }
    ).select("+authentication.salt");

export const setMfaEmailCode = (
    id: string,
    hash: string,
    email: MfaEmailCode,
    sentAt: Date,
    resendBefore: Date
) =>
    UserModel.findOneAndUpdate(
        {
            ...liveChallenge(id, hash),
            "authentication.mfaEmail": true,
            $or: [
                { "authentication.mfaEmailSentAt": { $exists: false } },
                { "authentication.mfaEmailSentAt": { $lte: resendBefore } }
            ]
        },
        {
            $set: {
                "authentication.mfaChallenge.email": email,
                "authentication.mfaEmailSentAt": sentAt
            }
        },
        { new: false }
    )
        .select(challengeFields)
        .lean();

export const restoreMfaEmailCode = (
    id: string,
    email: MfaEmailCode,
    previous: { mfaChallenge?: { email?: Partial<MfaEmailCode> }; mfaEmailSentAt?: Date }
) =>
    UserModel.updateOne(
        { _id: id, "authentication.mfaChallenge.email.hash": { $eq: email.hash } },
        [
            {
                $set: {
                    "authentication.mfaChallenge.email": previous.mfaChallenge?.email?.hash
                        ? { $literal: previous.mfaChallenge.email }
                        : "$$REMOVE",
                    "authentication.mfaEmailSentAt": previous.mfaEmailSentAt ?? "$$REMOVE"
                }
            }
        ]
    );

export const setMfaEmail = (id: string, on: boolean) =>
    UserModel.updateOne(
        { _id: id },
        on
            ? { $set: { "authentication.mfaEmail": true } }
            : { $unset: { "authentication.mfaEmail": 1, "authentication.mfaChallenge": 1 } }
    );
