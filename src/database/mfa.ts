import {
    MongoAggFieldRef,
    MongoAggLiteral,
    MongoExistsExpr,
    MongoFieldFilter,
    MongoFilterExpr,
    MongoOrExpr
} from "@prisma/orm-mongo/query-ast/execution";
import type { TypedUpdateOp } from "@prisma/orm-mongo/query-builder";

import {
    ExpiringHash,
    UserFields,
    findAndUpdateUser,
    findUser,
    updateUser,
    userExists
} from "./users";
import { allOf, idIs, literalValue } from "../helpers/prisma";
import { belowFailureCap, countedFailures, failureCountingClaim } from "./emailCodes";
import { EmailCodeFailures, codeFailuresWindowStart } from "../helpers/emailCodes";
import {
    MFA_CHALLENGE_ATTEMPTS,
    MFA_EMAILS_PER_DAY,
    SECURITY_NOTICES_PER_DAY
} from "../constants/limits";

export type MfaGithubLogin = {
    id: string;
    login: string;
};

export type MfaEmailCode = {
    hash: string;
    linkHash: string;
};

export interface MfaChallenge {
    hash: string;
    expiresAt: Date;
    attempts: number;
    github?: MfaGithubLogin;
    email?: MfaEmailCode;
}

const mfaEmailSends: string = "authentication.mfaEmailSends";

const liveChallenge = (id: string, hash: string): MongoFilterExpr =>
    allOf(
        idIs(id),
        MongoFieldFilter.eq("suspendedAt", null),
        MongoFieldFilter.eq("authentication.mfaChallenge.hash", hash),
        MongoFieldFilter.gt("authentication.mfaChallenge.expiresAt", new Date()),
        MongoFieldFilter.lt("authentication.mfaChallenge.attempts", MFA_CHALLENGE_ATTEMPTS)
    );

export const setMfaChallenge = (id: string, challenge: MfaChallenge, onFilter: MongoFilterExpr) =>
    updateUser(allOf(idIs(id), MongoFieldFilter.eq("suspendedAt", null), onFilter), (f) => [
        f("authentication.mfaChallenge").set({ ...challenge })
    ]);

export const getMfaChallengeUser = (id: string, hash: string, onFilter: MongoFilterExpr) =>
    findUser(liveChallenge(id, hash), onFilter);

export const getEndedMfaChallengeUser = (id: string, hash: string, onFilter: MongoFilterExpr) =>
    findUser(idIs(id), MongoFieldFilter.eq("authentication.mfaChallenge.hash", hash), onFilter);

export const dropMfaChallenge = (id: string, hash: string) =>
    updateUser(
        allOf(idIs(id), MongoFieldFilter.eq("authentication.mfaChallenge.hash", hash)),
        (f) => [f("authentication.mfaChallenge").unset()]
    );

export const claimMfaTry = (id: string, hash: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.mfaChallenge",
        "authentication.mfaFailures"
    );

    return findAndUpdateUser(allOf(liveChallenge(id, hash), belowCap), () => countGuess, "after");
};

export const hasMfaChallenge = (id: string, hash: string): Promise<boolean> =>
    userExists(
        idIs(id),
        MongoFieldFilter.eq("suspendedAt", null),
        MongoFieldFilter.eq("authentication.mfaChallenge.hash", hash),
        MongoFieldFilter.gt("authentication.mfaChallenge.expiresAt", new Date())
    );

export const uncountMfaFailure = (id: string, since: Date) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("authentication.mfaFailures.since", since),
            MongoFieldFilter.gt("authentication.mfaFailures.count", 0)
        ),
        (f) => [f("authentication.mfaFailures.count").inc(-1)]
    );

export interface MfaSpend {
    filter: MongoFilterExpr;
    update: (f: UserFields) => TypedUpdateOp[];
}

export const mfaSessionUpdate =
    (session: ExpiringHash, github: MfaGithubLogin | undefined, spend?: MfaSpend) =>
    (f: UserFields): TypedUpdateOp[] => [
        f("authentication.sessionToken").set(session.hash),
        f("authentication.sessionExpiresAt").set(session.expiresAt),
        ...(github
            ? [
                  f.githubLogin.set(github.login),
                  f("authentication.githubVerifiedAt").set(new Date())
              ]
            : []),
        f("authentication.mfaChallenge").unset(),
        ...(spend?.update(f) ?? [])
    ];

export const startMfaSession = (
    id: string,
    hash: string,
    session: ExpiringHash,
    github: MfaGithubLogin | undefined,
    spend?: MfaSpend
) =>
    findAndUpdateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("suspendedAt", null),
            MongoFieldFilter.eq("authentication.mfaChallenge.hash", hash),
            MongoFieldFilter.gt("authentication.mfaChallenge.expiresAt", new Date()),
            ...(github ? [MongoFieldFilter.eq("githubId", github.id)] : []),
            ...(spend ? [spend.filter] : [])
        ),
        mfaSessionUpdate(session, github, spend),
        "after"
    );

export const setMfaEmailCode = (
    id: string,
    hash: string,
    email: MfaEmailCode,
    sentAt: Date,
    resendBefore: Date
) => {
    const windowStart: Date = codeFailuresWindowStart();

    return findAndUpdateUser(
        allOf(
            liveChallenge(id, hash),
            MongoFieldFilter.eq("authentication.mfaEmail", true),
            MongoOrExpr.of([
                MongoExistsExpr.notExists("authentication.mfaEmailSentAt"),
                MongoFieldFilter.lte("authentication.mfaEmailSentAt", resendBefore)
            ]),
            belowFailureCap(mfaEmailSends, MFA_EMAILS_PER_DAY, windowStart)
        ),
        (f) => [
            f.stage.set({
                "authentication.mfaChallenge.email": literalValue(email),
                "authentication.mfaEmailSentAt": MongoAggLiteral.of(sentAt),
                ...countedFailures(mfaEmailSends, windowStart)
            })
        ],
        "before"
    );
};

const removed: MongoAggFieldRef = MongoAggFieldRef.of("$REMOVE");

export const restoreMfaEmailCode = (
    id: string,
    email: MfaEmailCode,
    previous: {
        mfaChallenge?: { email?: Partial<MfaEmailCode> };
        mfaEmailSentAt?: Date;
        mfaEmailSends?: EmailCodeFailures;
    }
) =>
    updateUser(
        allOf(idIs(id), MongoFieldFilter.eq("authentication.mfaChallenge.email.hash", email.hash)),
        (f) => [
            f.stage.set({
                "authentication.mfaChallenge.email": previous.mfaChallenge?.email?.hash
                    ? literalValue(previous.mfaChallenge.email)
                    : removed,
                "authentication.mfaEmailSentAt": previous.mfaEmailSentAt
                    ? MongoAggLiteral.of(previous.mfaEmailSentAt)
                    : removed,
                [mfaEmailSends]: previous.mfaEmailSends
                    ? literalValue(previous.mfaEmailSends)
                    : removed
            })
        ]
    );

const mfaMethodOff = (storedPaths: string[]) => (f: UserFields) =>
    ["authentication.mfaChallenge", ...storedPaths].map((path: string) => f.rawPath(path).unset());

export const turnOffMfaMethod = (reauthed: MongoFilterExpr, storedPaths: string[]) =>
    updateUser(reauthed, mfaMethodOff(storedPaths));

export const setMfaEmail = (
    reauthed: MongoFilterExpr,
    on: boolean,
    storedPaths: string[],
    onlyIfChanging: boolean
) =>
    updateUser(
        allOf(
            reauthed,
            ...(onlyIfChanging
                ? [
                      on
                          ? MongoFieldFilter.neq("authentication.mfaEmail", true)
                          : MongoFieldFilter.eq("authentication.mfaEmail", true)
                  ]
                : [])
        ),
        on ? (f) => [f("authentication.mfaEmail").set(true)] : mfaMethodOff(storedPaths)
    );

const securityNotices: string = "authentication.securityNotices";

export const claimSecurityNotice = (id: string) => {
    const windowStart: Date = codeFailuresWindowStart();

    return findAndUpdateUser(
        allOf(idIs(id), belowFailureCap(securityNotices, SECURITY_NOTICES_PER_DAY, windowStart)),
        (f) => [f.stage.set(countedFailures(securityNotices, windowStart))],
        "after"
    );
};

export const uncountSecurityNotice = (id: string, since: Date) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq(`${securityNotices}.since`, since),
            MongoFieldFilter.gt(`${securityNotices}.count`, 0)
        ),
        (f) => [f("authentication.securityNotices.count").inc(-1)]
    );

export const resetMfa = (id: string, resetPaths: string[]) =>
    updateUser(idIs(id), (f) =>
        [
            "authentication.sessionToken",
            "authentication.sessionExpiresAt",
            "authentication.mfaChallenge",
            "authentication.mfaFailures",
            "authentication.apiKeys",
            ...resetPaths
        ].map((path: string) => f.rawPath(path).unset())
    );
