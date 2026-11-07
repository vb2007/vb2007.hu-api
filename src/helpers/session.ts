import express from "express";
import dotenv from "dotenv";

import { ExpiringHash, UserModel, getUserBySessionToken, updateUserById } from "../database/users";
import { authentication, hashSessionToken, random } from ".";
import { SESSION_MAX_AGE_MS } from "../constants/limits";

dotenv.config();

export type UserDocument = InstanceType<typeof UserModel>;

export const sessionCookie: string = "__Host-VB-AUTH";

const sessionCookieOptions = (): express.CookieOptions => ({
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: process.env.NODE_ENV === "production" ? "lax" : undefined
});

export const getSessionUser = async (req: express.Request, fields: string = "") => {
    const sessionToken: string = req.cookies[sessionCookie];
    return sessionToken ? await getUserBySessionToken(sessionToken).select(fields) : null;
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

export const startSession = async (res: express.Response, user: UserDocument): Promise<void> => {
    const session: NewSession = createSession(user._id.toString());
    user.authentication.sessionToken = session.stored.hash;
    user.authentication.sessionExpiresAt = session.stored.expiresAt;
    await user.save();

    setSessionCookie(res, session.token);
};

export const revokeSession = async (userId: string): Promise<UserDocument | null> =>
    updateUserById(userId, {
        $unset: { "authentication.sessionToken": 1, "authentication.sessionExpiresAt": 1 }
    });

export const endSession = async (
    res: express.Response,
    user: UserDocument | null
): Promise<void> => {
    if (user) {
        await revokeSession(user._id.toString());
    }

    res.clearCookie(sessionCookie, sessionCookieOptions());
};
