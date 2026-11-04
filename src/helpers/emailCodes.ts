import express from "express";
import crypto from "crypto";

import { authentication } from ".";
import { Responses } from "../constants/responses";

export const EMAIL_CODE_MAX_ATTEMPTS: number = 5;
export const EMAIL_CODE_RESEND_SECONDS: number = 60;
export const CODE_FAILURES_WINDOW_MS: number = 24 * 60 * 60 * 1000;
export const CODE_FAILURES_PER_DAY: number = 20;

const emailCodePattern: RegExp = /^\d{6}$/;

export interface EmailCodeFailures {
    count: number;
    since: Date;
}

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

export const answerResendTooSoon = (res: express.Response, sentAt: Date | undefined) => {
    const retryAfter: number = Math.max(1, resendWaitSeconds(sentAt));

    return res
        .status(429)
        .set("Retry-After", String(retryAfter))
        .json({ error: Responses.EmailCodes.resendTooSoon(retryAfter), retryAfter });
};

export const codeFailuresWindowStart = (): Date => new Date(Date.now() - CODE_FAILURES_WINDOW_MS);

export const codeFailuresWaitSeconds = (failures: EmailCodeFailures | undefined): number =>
    failures?.count >= CODE_FAILURES_PER_DAY
        ? Math.max(
              0,
              Math.ceil((failures.since.getTime() + CODE_FAILURES_WINDOW_MS - Date.now()) / 1000)
          )
        : 0;

export const answerInvalidCode = (
    res: express.Response,
    error: string = Responses.EmailCodes.invalidCode
) => {
    res.locals.codeRejected = true;

    return res.status(400).json({ error });
};

export const answerUnclaimedCode = (
    res: express.Response,
    failures: EmailCodeFailures | undefined
) => {
    const retryAfter: number = codeFailuresWaitSeconds(failures);

    if (retryAfter === 0) {
        return answerInvalidCode(res);
    }

    return res
        .status(429)
        .set("Retry-After", String(retryAfter))
        .json({ error: Responses.tooManyFailedAttempts, retryAfter });
};

export const wasCodeRejected = (res: express.Response): boolean => res.locals.codeRejected === true;
