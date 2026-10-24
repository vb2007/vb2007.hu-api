import express from "express";
import dotenv from "dotenv";

import { UserModel, updateUserById } from "../database/users";
import { authentication, random } from ".";

dotenv.config();

type UserDocument = InstanceType<typeof UserModel>;

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

export const startSession = async (res: express.Response, user: UserDocument): Promise<void> => {
    user.authentication.sessionToken = authentication(random(), user._id.toString());
    await user.save();

    res.cookie("VB-AUTH", user.authentication.sessionToken, {
        ...sessionCookieOptions(),
        maxAge: 1000 * 60 * 60 * 24 * 7
    });
};

export const endSession = async (
    res: express.Response,
    user: UserDocument | null
): Promise<void> => {
    if (user) {
        await updateUserById(user._id.toString(), {
            $unset: { "authentication.sessionToken": 1 }
        });
    }

    res.clearCookie("VB-AUTH", sessionCookieOptions());
};
