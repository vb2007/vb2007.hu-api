import express from "express";
import dotenv from "dotenv";

import { UserModel, getUserBySessionToken, updateUserById } from "../database/users";
import { authentication, hashSessionToken, random } from ".";
import { SESSION_MAX_AGE_MS } from "../constants/limits";

dotenv.config();

export type UserDocument = InstanceType<typeof UserModel>;

const sessionCookieOptions = (): express.CookieOptions => {
    const isProduction: boolean = process.env.NODE_ENV === "production";

    return {
        domain: process.env.COOKIE_TARGET_DOMAIN,
        path: "/",
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "lax" : undefined
    };
};

export const getSessionUser = async (req: express.Request, fields: string = "") => {
    const sessionToken: string = req.cookies["VB-AUTH"];
    return sessionToken ? await getUserBySessionToken(sessionToken).select(fields) : null;
};

export const startSession = async (res: express.Response, user: UserDocument): Promise<void> => {
    const sessionToken: string = authentication(random(), user._id.toString());
    user.authentication.sessionToken = hashSessionToken(sessionToken);
    user.authentication.sessionExpiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    await user.save();

    res.cookie("VB-AUTH", sessionToken, {
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

    res.clearCookie("VB-AUTH", sessionCookieOptions());
};
