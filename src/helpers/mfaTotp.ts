import crypto from "crypto";
import dotenv from "dotenv";

import { normalizeEmailCode } from "./emailCodes";
import type { MfaMethod, MfaUser } from "./mfa";

dotenv.config();

const base32Alphabet: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const totpIssuer: string = "vb2007.hu";
const totpDigits: number = 6;
const totpPeriodSeconds: number = 30;

export const toBase32 = (bytes: Buffer): string =>
    [...bytes]
        .map((byte: number): string => byte.toString(2).padStart(8, "0"))
        .join("")
        .match(/.{1,5}/g)
        .map((bits: string): string => base32Alphabet[parseInt(bits.padEnd(5, "0"), 2)])
        .join("");

export const fromBase32 = (text: string): Buffer =>
    Buffer.from(
        (
            [...text.toUpperCase()]
                .map((char: string): string =>
                    base32Alphabet.indexOf(char).toString(2).padStart(5, "0")
                )
                .join("")
                .match(/.{8}/g) ?? []
        ).map((bits: string): number => parseInt(bits, 2))
    );

export const createTotpSecret = (): string => toBase32(crypto.randomBytes(20));

export const totpUrl = (accountName: string, secret: string): string =>
    `otpauth://totp/${totpIssuer}:${encodeURIComponent(accountName)}?${new URLSearchParams({
        secret,
        issuer: totpIssuer,
        algorithm: "SHA1",
        digits: String(totpDigits),
        period: String(totpPeriodSeconds)
    })}`;

export const totpCode = (key: Buffer, step: number): string => {
    const counter: Buffer = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac: Buffer = crypto.createHmac("sha1", key).update(counter).digest();
    const truncated: number = hmac.readUInt32BE(hmac[hmac.length - 1] & 0xf) & 0x7fffffff;

    return String(truncated % 10 ** totpDigits).padStart(totpDigits, "0");
};

export const totpStepAt = (ms: number): number => Math.floor(ms / 1000 / totpPeriodSeconds);

export const matchingTotpStep = (secret: string, code: string): number | null => {
    const key: Buffer = fromBase32(secret);
    const given: Buffer = Buffer.from(normalizeEmailCode(code));
    const now: number = totpStepAt(Date.now());

    return (
        [now - 1, now, now + 1].find((step: number): boolean => {
            const expected: Buffer = Buffer.from(totpCode(key, step));

            return given.length === expected.length && crypto.timingSafeEqual(given, expected);
        }) ?? null
    );
};

const totpKey: Buffer = crypto
    .createHmac("sha256", process.env.CRYPTO_SECRET_KEY)
    .update("mfa-totp")
    .digest();

export const encryptTotpSecret = (userId: string, secret: string): string => {
    const iv: Buffer = crypto.randomBytes(12);
    const cipher: crypto.CipherGCM = crypto.createCipheriv("aes-256-gcm", totpKey, iv);
    cipher.setAAD(Buffer.from(userId));
    const encrypted: Buffer = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

    return [iv, cipher.getAuthTag(), encrypted]
        .map((part: Buffer): string => part.toString("base64url"))
        .join(".");
};

export const decryptTotpSecret = (userId: string, stored: string): string | null => {
    try {
        const [iv, tag, encrypted] = stored
            .split(".")
            .map((part: string): Buffer => Buffer.from(part, "base64url"));
        const decipher: crypto.DecipherGCM = crypto.createDecipheriv("aes-256-gcm", totpKey, iv, {
            authTagLength: 16
        });
        decipher.setAAD(Buffer.from(userId));
        decipher.setAuthTag(tag);

        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
        return null;
    }
};

const newTotpStep = (user: MfaUser, code: unknown): number | null => {
    const { mfaTotpSecret, mfaTotpLastStep } = user.authentication;
    const secret: string | null = decryptTotpSecret(user._id.toString(), mfaTotpSecret);
    const step: number | null = secret === null ? null : matchingTotpStep(secret, String(code));

    return step !== null && step > (mfaTotpLastStep ?? -Infinity) ? step : null;
};

export const totpMfa: MfaMethod = {
    fields: "+authentication.mfaTotpSecret +authentication.mfaTotpLastStep",
    storedPaths: [
        "authentication.mfaTotpSecret",
        "authentication.mfaTotpLastStep",
        "authentication.mfaTotpSetup"
    ],
    onFilter: { "authentication.mfaTotpSecret": { $exists: true } },
    isOn: (authentication) => Boolean(authentication?.mfaTotpSecret),
    isWellFormed: ({ code }) => typeof code === "string" && code !== "",
    verify: (user, { code }) => newTotpStep(user, code) !== null,
    spend: (user, { code }) => {
        const step: number | null = newTotpStep(user, code);

        return step === null
            ? null
            : {
                  filter: {
                      "authentication.mfaTotpSecret": { $eq: user.authentication.mfaTotpSecret },
                      "authentication.mfaTotpLastStep": { $not: { $gte: step } }
                  },
                  update: { $set: { "authentication.mfaTotpLastStep": step } }
              };
    }
};
