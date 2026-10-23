import express from "express";
import dotenv from "dotenv";

import { UserModel } from "../database/users";
import { authentication, random } from ".";

dotenv.config();

type UserDocument = InstanceType<typeof UserModel>;

export const startSession = async (res: express.Response, user: UserDocument): Promise<void> => {
    user.authentication.sessionToken = authentication(random(), user._id.toString());
    await user.save();

    const isProduction: boolean = process.env.NODE_ENV === "production";

    res.cookie("VB-AUTH", user.authentication.sessionToken, {
        domain: process.env.COOKIE_TARGET_DOMAIN,
        path: "/",
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "lax" : undefined,
        maxAge: 1000 * 60 * 60 * 24 * 7
    });
};
