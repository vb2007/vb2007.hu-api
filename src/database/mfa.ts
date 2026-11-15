import { ExpiringHash, UserModel, reauthedSessionFilter } from "./users";
import { countedFailures, failureCountingClaim } from "./emailCodes";
import { EmailCodeFailures, codeFailuresWindowStart } from "../helpers/emailCodes";
import { MFA_CHALLENGE_ATTEMPTS, MFA_EMAILS_PER_DAY } from "../constants/limits";

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

const challengeFields: string =
    "+authentication.mfaChallenge +authentication.mfaEmailSentAt +authentication.mfaEmailSends";

const mfaEmailSends: string = "authentication.mfaEmailSends";

const liveChallenge = (id: string, hash: string) => ({
    _id: id,
    suspendedAt: null as Date | null,
    "authentication.mfaChallenge.hash": { $eq: hash },
    "authentication.mfaChallenge.expiresAt": { $gt: new Date() },
    "authentication.mfaChallenge.attempts": { $lt: MFA_CHALLENGE_ATTEMPTS }
});

export type MfaOnFilter = { $or: Record<string, unknown>[] };

export const setMfaChallenge = (id: string, challenge: MfaChallenge, onFilter: MfaOnFilter) =>
    UserModel.updateOne(
        { _id: id, suspendedAt: null, ...onFilter },
        { $set: { "authentication.mfaChallenge": challenge } }
    );

export const getMfaChallengeUser = (
    id: string,
    hash: string,
    fields: string,
    onFilter: MfaOnFilter
) =>
    UserModel.findOne({ ...liveChallenge(id, hash), ...onFilter })
        .select(`${challengeFields} ${fields}`)
        .lean();

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
) => {
    const windowStart: Date = codeFailuresWindowStart();

    return UserModel.findOneAndUpdate(
        {
            ...liveChallenge(id, hash),
            "authentication.mfaEmail": true,
            $and: [
                {
                    $or: [
                        { "authentication.mfaEmailSentAt": { $exists: false } },
                        { "authentication.mfaEmailSentAt": { $lte: resendBefore } }
                    ]
                },
                {
                    $or: [
                        { [`${mfaEmailSends}.count`]: { $not: { $gte: MFA_EMAILS_PER_DAY } } },
                        { [`${mfaEmailSends}.since`]: { $lte: windowStart } }
                    ]
                }
            ]
        },
        [
            {
                $set: {
                    "authentication.mfaChallenge.email": { $literal: email },
                    "authentication.mfaEmailSentAt": sentAt,
                    [mfaEmailSends]: countedFailures(mfaEmailSends, windowStart)
                }
            }
        ],
        { new: false }
    )
        .select(challengeFields)
        .lean();
};

export const restoreMfaEmailCode = (
    id: string,
    email: MfaEmailCode,
    previous: {
        mfaChallenge?: { email?: Partial<MfaEmailCode> };
        mfaEmailSentAt?: Date;
        mfaEmailSends?: EmailCodeFailures;
    }
) =>
    UserModel.updateOne(
        { _id: id, "authentication.mfaChallenge.email.hash": { $eq: email.hash } },
        [
            {
                $set: {
                    "authentication.mfaChallenge.email": previous.mfaChallenge?.email?.hash
                        ? { $literal: previous.mfaChallenge.email }
                        : "$$REMOVE",
                    "authentication.mfaEmailSentAt": previous.mfaEmailSentAt ?? "$$REMOVE",
                    [mfaEmailSends]: previous.mfaEmailSends
                        ? { $literal: previous.mfaEmailSends }
                        : "$$REMOVE"
                }
            }
        ]
    );

export const setMfaEmail = (
    reauthed: ReturnType<typeof reauthedSessionFilter>,
    on: boolean,
    storedPaths: string[]
) =>
    UserModel.updateOne(
        reauthed,
        on
            ? { $set: { "authentication.mfaEmail": true } }
            : {
                  $unset: Object.fromEntries(
                      ["authentication.mfaChallenge", ...storedPaths].map((path) => [path, 1])
                  )
              }
    );

export const resetMfa = (id: string, resetPaths: string[]) =>
    UserModel.updateOne(
        { _id: id },
        {
            $unset: Object.fromEntries(
                [
                    "authentication.sessionToken",
                    "authentication.sessionExpiresAt",
                    "authentication.mfaChallenge",
                    "authentication.mfaFailures",
                    ...resetPaths
                ].map((path) => [path, 1])
            )
        }
    );
