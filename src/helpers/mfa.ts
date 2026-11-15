import express from "express";

import { authentication } from ".";
import { createOauthSecret } from "./github";
import { rememberDevice } from "./deviceCookie";
import { answerInvalidCode, answerUnclaimedCode } from "./emailCodes";
import { createSession, setSessionCookie } from "./session";
import { emailMfa } from "./mfaEmail";
import { passkeyMfa } from "./mfaPasskey";
import {
    MfaGithubLogin,
    claimMfaTry,
    dropMfaChallenge,
    getMfaChallengeUser,
    setMfaChallenge,
    startMfaSession,
    uncountMfaFailure
} from "../database/mfa";
import { MFA_CHALLENGE_ATTEMPTS, MFA_CHALLENGE_MINUTES } from "../constants/limits";
import { Responses } from "../constants/responses";

export type MfaUser = NonNullable<Awaited<ReturnType<typeof claimMfaTry>>>;

export interface MfaMethod {
    fields: string;
    storedPaths: string[];
    isOn: (authentication: Partial<MfaUser["authentication"]> | undefined) => boolean;
    isWellFormed: (body: Record<string, unknown>) => boolean;
    verify: (user: MfaUser, body: Record<string, unknown>) => boolean | Promise<boolean>;
    invalidError?: string;
}

export const mfaMethods: Record<string, MfaMethod> = {
    email: emailMfa,
    passkey: passkeyMfa
};

export const mfaFields: string = Object.values(mfaMethods)
    .map(({ fields }: MfaMethod): string => fields)
    .join(" ");

export const mfaMethodsOn = (
    authentication: Partial<MfaUser["authentication"]> | undefined
): string[] =>
    Object.keys(mfaMethods).filter((name: string): boolean =>
        mfaMethods[name].isOn(authentication)
    );

export const mfaCookie: string = "__Host-VB-MFA";

const mfaCookieOptions: express.CookieOptions = {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax"
};

const mfaTokenPattern: RegExp = /^([0-9a-f]{24})\.([\w-]{43})$/;

const parseMfaToken = (token: unknown): string[] =>
    typeof token === "string" ? (mfaTokenPattern.exec(token)?.slice(1) ?? []) : [];

export interface MfaChallengeCookie {
    id: string;
    hash: string;
}

const mfaChallengeHash = (id: string, secret: string): string =>
    authentication(`mfaChallenge:${id}`, secret);

export const mfaChallengeOf = (req: express.Request): MfaChallengeCookie | null => {
    const [id, secret] = parseMfaToken(req.cookies?.[mfaCookie]);

    return id ? { id, hash: mfaChallengeHash(id, secret) } : null;
};

export const getMfaUser = (challenge: MfaChallengeCookie | null, fields: string = "") =>
    challenge ? getMfaChallengeUser(challenge.id, challenge.hash, `${mfaFields} ${fields}`) : null;

export const startMfaChallenge = async (
    res: express.Response,
    userId: string,
    github?: MfaGithubLogin
): Promise<boolean> => {
    const secret: string = createOauthSecret();
    const validMs: number = MFA_CHALLENGE_MINUTES * 60 * 1000;
    const { matchedCount } = await setMfaChallenge(userId, {
        hash: mfaChallengeHash(userId, secret),
        expiresAt: new Date(Date.now() + validMs),
        attempts: 0,
        ...(github && { github })
    });

    if (matchedCount === 0) {
        return false;
    }

    res.cookie(mfaCookie, `${userId}.${secret}`, { ...mfaCookieOptions, maxAge: validMs });
    return true;
};

export const answerMfaChallengeExpired = (res: express.Response) => {
    res.clearCookie(mfaCookie, mfaCookieOptions);

    return res.status(403).json({ error: Responses.Mfa.challengeExpired });
};

export const dropMfaChallengeOf = async (
    req: express.Request,
    res: express.Response
): Promise<void> => {
    const challenge: MfaChallengeCookie | null = mfaChallengeOf(req);

    if (challenge) {
        await dropMfaChallenge(challenge.id, challenge.hash);
        res.clearCookie(mfaCookie, mfaCookieOptions);
    }
};

const answerUnclaimedTry = async (res: express.Response, challenge: MfaChallengeCookie) => {
    const user = await getMfaUser(challenge, "+authentication.mfaFailures");

    if (user) {
        return answerUnclaimedCode(res, user.authentication.mfaFailures);
    }

    await dropMfaChallenge(challenge.id, challenge.hash);
    return answerMfaChallengeExpired(res);
};

export const completeMfaLogin = async (
    res: express.Response,
    challenge: MfaChallengeCookie,
    check: (user: MfaUser) => boolean | Promise<boolean>,
    invalidError?: string
) => {
    const user = await claimMfaTry(challenge.id, challenge.hash, mfaFields);

    if (!user) {
        return answerUnclaimedTry(res, challenge);
    }

    if (!(await check(user))) {
        if (user.authentication.mfaChallenge.attempts >= MFA_CHALLENGE_ATTEMPTS) {
            await dropMfaChallenge(challenge.id, challenge.hash);
        }

        return answerInvalidCode(res, invalidError);
    }

    await uncountMfaFailure(challenge.id, user.authentication.mfaFailures.since);

    const { id, login } = user.authentication.mfaChallenge.github ?? {};
    const github: MfaGithubLogin | undefined = id ? { id, login } : undefined;
    const session = createSession(challenge.id);
    const started = await startMfaSession(challenge.id, challenge.hash, session.stored, github);

    if (!started) {
        return answerMfaChallengeExpired(res);
    }

    setSessionCookie(res, session.token);
    res.clearCookie(mfaCookie, mfaCookieOptions);

    if (!github) {
        rememberDevice(res, started);
    }

    return res
        .status(200)
        .json({ message: Responses.Authentication.loginSuccess(started.username) });
};
