import express from "express";
import crypto from "crypto";
import { Options, RateLimitRequestHandler, rateLimit } from "express-rate-limit";
import { get } from "lodash";

import { Responses } from "../constants/responses";
import { normalizeEmail } from "../helpers";

export const FAILED_ATTEMPTS_WINDOW_MS: number = 15 * 60 * 1000;
export const FAILED_ATTEMPTS_PER_ACCOUNT: number = 10;
export const FAILED_ATTEMPTS_PER_IP: number = 100;

const failedAttemptStatuses: number[] = [403, 404];

const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value !== "";

const lacksLoginCredentials = (req: express.Request): boolean =>
    !isNonEmptyString(get(req, "body.email")) || !isNonEmptyString(get(req, "body.password"));

const hashedLoginEmail = (req: express.Request): string =>
    crypto
        .createHash("sha256")
        .update(normalizeEmail(get(req, "body.email")))
        .digest("hex");

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
        message: { error: Responses.tooManyFailedAttempts },
        ...options
    });

export const limitLoginAttempts: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, { skip: lacksLoginCredentials }),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        skip: lacksLoginCredentials,
        keyGenerator: hashedLoginEmail
    })
];

export const limitPasswordChecks: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        keyGenerator: (req: express.Request): string => String(get(req, "identity._id"))
    })
];
