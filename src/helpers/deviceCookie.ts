import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

import { normalizeEmail } from ".";

dotenv.config();

export const deviceCookie: string = "VB-DEVICE";
export const DEVICE_COOKIE_MAX_AGE_MS: number = 1000 * 60 * 60 * 24 * 30;

const deviceCookiePattern: RegExp = /^(\d{1,15})\.([0-9a-f]{64})$/;

const deviceSignature = (email: string, issuedAt: string): Buffer =>
    crypto
        .createHmac("sha256", process.env.CRYPTO_SECRET_KEY)
        .update(`device:${issuedAt}:${normalizeEmail(email)}`)
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

export const deviceCookieValue = (email: string, issuedAt: number): string =>
    `${issuedAt}.${deviceSignature(email, String(issuedAt)).toString("hex")}`;

export const rememberDevice = (res: express.Response, email: string): void => {
    res.cookie(deviceCookie, deviceCookieValue(email, Date.now()), deviceCookieOptions());
};

export const isRememberedDevice = (req: express.Request, email: string): boolean => {
    const match: RegExpMatchArray | null = String(req.cookies?.[deviceCookie] ?? "").match(
        deviceCookiePattern
    );

    if (!match) {
        return false;
    }

    const [, issuedAt, signature] = match;
    const age: number = Date.now() - Number(issuedAt);

    return (
        age >= 0 &&
        age < DEVICE_COOKIE_MAX_AGE_MS &&
        crypto.timingSafeEqual(Buffer.from(signature, "hex"), deviceSignature(email, issuedAt))
    );
};
