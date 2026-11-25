import express from "express";
import dotenv from "dotenv";

import {
    ExpiringHash,
    User,
    getUserById,
    getUserBySessionToken,
    revokeUserSession,
    setUserSession
} from "../database/users";
import { authentication, hashSessionToken, random } from ".";
import { SESSION_MAX_AGE_MS } from "../constants/limits";
import { Responses } from "../constants/responses";

dotenv.config();

export const sessionCookie: string = "__Host-VB-AUTH";

const sessionCookieOptions = (): express.CookieOptions => ({
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax"
});

export const getSessionUser = async (req: express.Request): Promise<User | null> => {
    const sessionToken: string = req.cookies[sessionCookie];
    return sessionToken ? await getUserBySessionToken(sessionToken) : null;
};

export interface NewSession {
    token: string;
    stored: ExpiringHash;
}

export const createSession = (userId: string): NewSession => {
    const token: string = authentication(random(), userId);

    return {
        token,
        stored: {
            hash: hashSessionToken(token),
            expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS)
        }
    };
};

export const setSessionCookie = (res: express.Response, sessionToken: string): void => {
    res.cookie(sessionCookie, sessionToken, {
        ...sessionCookieOptions(),
        maxAge: SESSION_MAX_AGE_MS
    });
};

export const startSessionWith = async (
    res: express.Response,
    userId: string,
    store: (session: ExpiringHash) => Promise<{ matchedCount: number }>
): Promise<boolean> => {
    const session: NewSession = createSession(userId);
    const { matchedCount } = await store(session.stored);

    if (matchedCount === 0) {
        return false;
    }

    setSessionCookie(res, session.token);
    return true;
};

const startSession = (res: express.Response, userId: string): Promise<boolean> =>
    startSessionWith(res, userId, (session: ExpiringHash) => setUserSession(userId, session));

export const startSessionIfPresent = async (
    res: express.Response,
    user: User | null
): Promise<boolean> => Boolean(user) && (await startSession(res, user._id));

export const answerLoginMiss = async (
    res: express.Response,
    userId: string,
    otherError: string = Responses.Authentication.invalidCredentials
) =>
    res.status(403).json({
        error: (await getUserById(userId))?.suspendedAt
            ? Responses.Authentication.accountSuspended
            : otherError
    });

export const endSession = async (res: express.Response, user: User | null): Promise<void> => {
    if (user) {
        await revokeUserSession(user._id);
    }

    res.clearCookie(sessionCookie, sessionCookieOptions());
};
