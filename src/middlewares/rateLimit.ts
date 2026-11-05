import express from "express";
import crypto from "crypto";
import {
    Options,
    RateLimitRequestHandler,
    ValueDeterminingMiddleware,
    ipKeyGenerator,
    rateLimit
} from "express-rate-limit";
import { get } from "lodash";

import {
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    FAILED_LOGINS_PER_EMAIL,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    USERNAME_CHECKS_PER_IP,
    USERNAME_CHECKS_WINDOW_MS
} from "../constants/limits";
import { Responses } from "../constants/responses";
import { normalizeEmail } from "../helpers";
import { rememberedDeviceSignature } from "../helpers/deviceCookie";
import { wasCodeRejected } from "../helpers/emailCodes";

const failedAttemptStatuses: number[] = [403, 404];

const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value !== "";

const lacksLoginCredentials = (req: express.Request): boolean =>
    !isNonEmptyString(get(req, "body.email")) || !isNonEmptyString(get(req, "body.password"));

const lacksEmail = (req: express.Request): boolean => !isNonEmptyString(get(req, "body.email"));

const hashedEmail = (req: express.Request): string =>
    crypto
        .createHash("sha256")
        .update(normalizeEmail(get(req, "body.email")))
        .digest("hex");

const hashedEmailAndIp = (req: express.Request): string =>
    `${hashedEmail(req)}:${ipKeyGenerator(req.ip, 48)}`;

const hashedEmailAndDevice = async (req: express.Request): Promise<string> => {
    const signature: string | null = await rememberedDeviceSignature(req, get(req, "body.email"));

    return signature ? `${hashedEmail(req)}:${signature}` : hashedEmail(req);
};

interface LimitedMessage {
    error: string;
    retryAfter: number;
}

const retryAfterSeconds = (req: express.Request): number => {
    const resetTime: Date = get(req, "rateLimit.resetTime");

    return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
};

const limitedMessage =
    (error: string): ValueDeterminingMiddleware<LimitedMessage> =>
    (req: express.Request, res: express.Response): LimitedMessage => {
        const retryAfter: number = retryAfterSeconds(req);
        res.set("Retry-After", String(retryAfter));

        return { error, retryAfter };
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
        message: limitedMessage(Responses.tooManyFailedAttempts),
        ...options
    });

export const limitLoginAttempts: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, { skip: lacksLoginCredentials }),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        skip: lacksLoginCredentials,
        keyGenerator: hashedEmailAndIp
    }),
    limitFailedAttempts(FAILED_LOGINS_PER_EMAIL, {
        skip: lacksLoginCredentials,
        keyGenerator: hashedEmailAndDevice,
        standardHeaders: false
    })
];

const wasCodeAccepted = (req: express.Request, res: express.Response): boolean =>
    !wasCodeRejected(res);

export const limitCodeChecks: RateLimitRequestHandler[] = [
    limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, { requestWasSuccessful: wasCodeAccepted }),
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        skip: lacksEmail,
        keyGenerator: hashedEmail,
        standardHeaders: false,
        requestWasSuccessful: wasCodeAccepted
    })
];

export const limitResetLinkChecks: RateLimitRequestHandler = limitFailedAttempts(
    FAILED_ATTEMPTS_PER_IP,
    { requestWasSuccessful: wasCodeAccepted }
);

export const limitMailSends: RateLimitRequestHandler = rateLimit({
    windowMs: MAIL_SENDS_WINDOW_MS,
    limit: MAIL_SENDS_PER_IP,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipFailedRequests: true,
    message: limitedMessage(Responses.tooManyEmails)
});

export const limitUsernameChecks: RateLimitRequestHandler = rateLimit({
    windowMs: USERNAME_CHECKS_WINDOW_MS,
    limit: USERNAME_CHECKS_PER_IP,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: limitedMessage(Responses.tooManyUsernameChecks)
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
