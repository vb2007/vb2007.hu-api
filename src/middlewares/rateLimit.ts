import express from "express";
import { RateLimitRequestHandler, rateLimit } from "express-rate-limit";
import { get } from "lodash";

import { Responses } from "../constants/responses";
import { normalizeEmail } from "../helpers";

export const FAILED_ATTEMPTS_WINDOW_MS: number = 15 * 60 * 1000;
export const FAILED_ATTEMPTS_PER_ACCOUNT: number = 10;
export const FAILED_ATTEMPTS_PER_IP: number = 100;

const failedAttemptStatuses: number[] = [403, 404];

const limitFailedAttempts = (
    limit: number,
    keyGenerator?: (req: express.Request) => string
): RateLimitRequestHandler =>
    rateLimit({
        windowMs: FAILED_ATTEMPTS_WINDOW_MS,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        requestWasSuccessful: (req: express.Request, res: express.Response): boolean =>
            !failedAttemptStatuses.includes(res.statusCode),
        message: { error: Responses.tooManyFailedAttempts },
        keyGenerator
    });

export const limitLoginAttempts: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, (req: express.Request): string =>
        normalizeEmail(String(get(req, "body.email", "")))
    )
];

export const limitPasswordChecks: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, (req: express.Request): string =>
        String(get(req, "identity._id"))
    )
];
