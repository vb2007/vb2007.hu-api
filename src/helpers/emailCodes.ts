import crypto from "crypto";

import { authentication } from ".";

export const EMAIL_CODE_MAX_ATTEMPTS: number = 5;
export const EMAIL_CODE_RESEND_SECONDS: number = 60;

const emailCodePattern: RegExp = /^\d{6}$/;

export interface EmailCode {
    hash: string;
    sentAt: Date;
    expiresAt: Date;
    attempts: number;
}

export const createEmailCode = (): string =>
    crypto.randomInt(0, 1000000).toString().padStart(6, "0");

export const hashEmailCode = (scope: string, code: string): string => authentication(scope, code);

export const issueEmailCode = (scope: string, code: string, validMinutes: number): EmailCode => {
    const sentAt: Date = new Date();

    return {
        hash: hashEmailCode(scope, code),
        sentAt,
        expiresAt: new Date(sentAt.getTime() + validMinutes * 60 * 1000),
        attempts: 0
    };
};

export const normalizeEmailCode = (code: string): string => code.replace(/\s/g, "");

export const isEmailCodeMatch = (hash: string, scope: string, code: string): boolean =>
    emailCodePattern.test(code) &&
    crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(hashEmailCode(scope, code), "hex")
    );

export const resendAllowedBefore = (): Date =>
    new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000);

export const resendWaitSeconds = (sentAt: Date | undefined): number =>
    sentAt
        ? Math.max(
              0,
              Math.ceil((sentAt.getTime() + EMAIL_CODE_RESEND_SECONDS * 1000 - Date.now()) / 1000)
          )
        : 0;
