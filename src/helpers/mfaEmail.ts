import crypto from "crypto";

import { authentication } from ".";
import { isEmailCodeMatch, normalizeEmailCode } from "./emailCodes";
import type { MfaMethod, MfaUser } from "./mfa";

const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

export const mfaEmailCodeScope = (id: string, challengeHash: string): string =>
    `mfaEmail:${id}:${challengeHash}`;

export const mfaEmailLinkHash = (id: string, challengeHash: string, secret: string): string =>
    authentication(`mfaEmailLink:${id}:${challengeHash}`, secret);

export const mfaEmailPage = (secret: string): string => `${baseSiteUrl}/login/mfa#token=${secret}`;

export const isMfaEmailLinkMatch = (user: MfaUser, secret: string): boolean => {
    const { hash, email } = user.authentication.mfaChallenge;

    return (
        Boolean(email?.linkHash) &&
        crypto.timingSafeEqual(
            Buffer.from(email.linkHash, "hex"),
            Buffer.from(mfaEmailLinkHash(user._id.toString(), hash, secret), "hex")
        )
    );
};

export const emailMfa: MfaMethod = {
    fields: "+authentication.mfaEmail",
    storedPaths: ["authentication.mfaEmail"],
    isOn: (authentication) => Boolean(authentication?.mfaEmail),
    isWellFormed: ({ code }) => typeof code === "string" && code !== "",
    verify: (user, { code }) => {
        const { hash, email } = user.authentication.mfaChallenge;

        return (
            Boolean(email?.hash) &&
            isEmailCodeMatch(
                email.hash,
                mfaEmailCodeScope(user._id.toString(), hash),
                normalizeEmailCode(String(code))
            )
        );
    }
};
