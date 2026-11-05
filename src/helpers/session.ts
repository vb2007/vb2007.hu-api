import express from "express";
import dotenv from "dotenv";

import { UserModel, getUserBySessionToken, updateUserById } from "../database/users";
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

export const startSession = async (res: express.Response, user: UserDocument): Promise<void> => {
    const sessionToken: string = authentication(random(), user._id.toString());
    user.authentication.sessionToken = hashSessionToken(sessionToken);
    user.authentication.sessionExpiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    await user.save();

    res.cookie(sessionCookie, sessionToken, {
        ...sessionCookieOptions(),
        maxAge: SESSION_MAX_AGE_MS
    });
};

export const endSession = async (
    res: express.Response,
    user: UserDocument | null
): Promise<void> => {
    if (user) {
        await updateUserById(user._id.toString(), {
            $unset: { "authentication.sessionToken": 1, "authentication.sessionExpiresAt": 1 }
        });
    }

    res.clearCookie(sessionCookie, sessionCookieOptions());
};
