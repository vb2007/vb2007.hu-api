import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

import { DEVICE_COOKIE_MAX_AGE_MS } from "../constants/limits";
import { getUserByEmail } from "../database/users";
import { normalizeEmail } from ".";
import { UserDocument } from "./session";

dotenv.config();

export const deviceCookie: string = "VB-DEVICE";

const deviceCookiePattern: RegExp = /^(\d{1,15})\.([0-9a-f]{64})$/;

const deviceSignature = (user: UserDocument, issuedAt: string): Buffer =>
    crypto
        .createHmac("sha256", process.env.CRYPTO_SECRET_KEY)
        .update(
            [
                "device",
                issuedAt,
                user._id.toString(),
                user.authentication.salt,
                normalizeEmail(user.email)
            ].join(":")
        )
        .digest();

const deviceCookieOptions = (): express.CookieOptions => {
    const isProduction: boolean = process.env.NODE_ENV === "production";

    return {
        path: "/auth/login",
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "lax" : undefined,
        maxAge: DEVICE_COOKIE_MAX_AGE_MS
    };
};

export const deviceCookieValue = (user: UserDocument, issuedAt: number): string =>
    `${issuedAt}.${deviceSignature(user, String(issuedAt)).toString("hex")}`;

export const rememberDevice = (res: express.Response, user: UserDocument): void => {
    res.cookie(deviceCookie, deviceCookieValue(user, Date.now()), deviceCookieOptions());
};

export const rememberedDeviceSignature = async (
    req: express.Request,
    email: string
): Promise<string | null> => {
    const match: RegExpMatchArray | null = String(req.cookies?.[deviceCookie] ?? "").match(
        deviceCookiePattern
    );

    if (!match) {
        return null;
    }

    const [, issuedAt, signature] = match;
    const age: number = Date.now() - Number(issuedAt);

    if (age < 0 || age >= DEVICE_COOKIE_MAX_AGE_MS) {
        return null;
    }

    const user = await getUserByEmail(normalizeEmail(email)).select("+authentication.salt");

    return user?.authentication?.salt &&
        crypto.timingSafeEqual(Buffer.from(signature, "hex"), deviceSignature(user, issuedAt))
        ? signature
        : null;
};
