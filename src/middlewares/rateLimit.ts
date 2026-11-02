import express from "express";
import crypto from "crypto";
import { Options, RateLimitRequestHandler, rateLimit } from "express-rate-limit";
import { get } from "lodash";

import { Responses } from "../constants/responses";
import { normalizeEmail } from "../helpers";

export const FAILED_ATTEMPTS_WINDOW_MS: number = 15 * 60 * 1000;
export const FAILED_ATTEMPTS_PER_ACCOUNT: number = 10;
export const FAILED_ATTEMPTS_PER_IP: number = 100;
export const MAIL_SENDS_WINDOW_MS: number = 60 * 60 * 1000;
export const MAIL_SENDS_PER_IP: number = 10;

const failedAttemptStatuses: number[] = [403, 404];
const failedCodeStatuses: number[] = [400];

const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value !== "";

const lacksLoginCredentials = (req: express.Request): boolean =>
    !isNonEmptyString(get(req, "body.email")) || !isNonEmptyString(get(req, "body.password"));

const lacksEmail = (req: express.Request): boolean => !isNonEmptyString(get(req, "body.email"));

const hashedEmail = (req: express.Request): string =>
    crypto
        .createHash("sha256")
        .update(normalizeEmail(get(req, "body.email")))
        .digest("hex");

const limitedWith =
    (error: string, windowMs: number) =>
    (req: express.Request): { error: string; retryAfter: number } => {
        const resetTime: Date | undefined = get(req, "rateLimit.resetTime");
        const remainingMs: number = resetTime ? resetTime.getTime() - Date.now() : windowMs;

        return { error, retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)) };
    };

const limitFailedAttempts = (
    limit: number,
    options: Partial<Options> = {}
): RateLimitRequestHandler =>
    rateLimit({
        windowMs: FAILED_ATTEMPTS_WINDOW_MS,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        requestWasSuccessful: (req: express.Request, res: express.Response): boolean =>
            !failedAttemptStatuses.includes(res.statusCode),
        message: limitedWith(Responses.tooManyFailedAttempts, FAILED_ATTEMPTS_WINDOW_MS),
        ...options
    });

export const limitLoginAttempts: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, { skip: lacksLoginCredentials }),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        skip: lacksLoginCredentials,
        keyGenerator: hashedEmail
    })
];

const wasCodeAccepted = (req: express.Request, res: express.Response): boolean =>
    !failedCodeStatuses.includes(res.statusCode);

export const limitCodeChecks: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, { requestWasSuccessful: wasCodeAccepted }),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        skip: lacksEmail,
        keyGenerator: hashedEmail,
        requestWasSuccessful: wasCodeAccepted
    })
];

export const limitMailSends: RateLimitRequestHandler = rateLimit({
    windowMs: MAIL_SENDS_WINDOW_MS,
    limit: MAIL_SENDS_PER_IP,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipFailedRequests: true,
    message: limitedWith(Responses.tooManyEmails, MAIL_SENDS_WINDOW_MS)
});

const identityId = (req: express.Request): string => String(get(req, "identity._id"));

export const limitAccountCodeChecks: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, { requestWasSuccessful: wasCodeAccepted }),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        keyGenerator: identityId,
        requestWasSuccessful: wasCodeAccepted
    })
];

export const limitPasswordChecks: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, { keyGenerator: identityId })
];
