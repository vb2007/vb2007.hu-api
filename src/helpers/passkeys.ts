import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import { COSEALG } from "@simplewebauthn/server/helpers";

import { PASSKEY_CHALLENGE_MINUTES, PASSKEY_NAME_MAX_LENGTH } from "../constants/limits";
import { Responses } from "../constants/responses";
import { Passkey, claimPasskeyChallenge, savePasskeyChallenge } from "../database/passkeys";
import { hashSessionToken } from ".";

dotenv.config();

const baseSiteUrl: URL = new URL(process.env.BASE_SITE_URL || "https://vb2007.hu");

export const passkeyRpId: string = baseSiteUrl.hostname;
export const passkeyOrigin: string = baseSiteUrl.origin;
export const passkeyAlgorithms: number[] = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];
export const passkeyChallengeMs: number = PASSKEY_CHALLENGE_MINUTES * 60 * 1000;

export const passkeyRegistrationCookie: string = "__Host-VB-PASSKEY-REG";
export const passkeyLoginCookie: string = "__Host-VB-PASSKEY-LOGIN";

const challengeCookieOf = (userId: string | null): string =>
    userId ? passkeyRegistrationCookie : passkeyLoginCookie;

const passkeyCookieOptions = (): express.CookieOptions => ({
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax"
});

const knownTransports: string[] = [
    "ble",
    "cable",
    "hybrid",
    "internal",
    "nfc",
    "smart-card",
    "usb"
];

export const passkeyTransports = (transports: unknown): string[] =>
    Array.isArray(transports)
        ? knownTransports.filter((transport: string): boolean => transports.includes(transport))
        : [];

export const userHandleOf = (userId: string): string =>
    Buffer.from(userId, "hex").toString("base64url");

const credentialIdPattern: RegExp = /^[\w-]{1,1364}$/;

export const isCredentialId = (id: unknown): id is string =>
    typeof id === "string" && credentialIdPattern.test(id);

export const passkeyNameError = (name: unknown): string | null => {
    if (typeof name !== "string" || !name.trim()) {
        return Responses.Passkeys.missingName;
    }

    return [...name.trim()].length > PASSKEY_NAME_MAX_LENGTH
        ? Responses.Passkeys.nameTooLong
        : null;
};

export const toPasskeyListItem = ({ credentialId, name, createdAt, lastUsedAt }: Passkey) => ({
    id: credentialId,
    name,
    createdAt,
    lastUsedAt: lastUsedAt ?? null
});

export const storePasskeyChallenge = async (
    res: express.Response,
    challenge: string,
    userId: string | null
): Promise<void> => {
    const id: string = crypto.randomBytes(32).toString("base64url");

    await savePasskeyChallenge(
        hashSessionToken(id),
        challenge,
        userId,
        new Date(Date.now() + passkeyChallengeMs)
    );

    res.cookie(challengeCookieOf(userId), id, {
        ...passkeyCookieOptions(),
        maxAge: passkeyChallengeMs
    });
};

export const takePasskeyChallenge = async (
    req: express.Request,
    res: express.Response,
    userId: string | null
): Promise<string | null> => {
    const cookie: string = challengeCookieOf(userId);
    const id: unknown = req.cookies[cookie];

    if (typeof id !== "string" || !id) {
        return null;
    }

    res.clearCookie(cookie, passkeyCookieOptions());

    return (await claimPasskeyChallenge(hashSessionToken(id), userId))?.challenge ?? null;
};
