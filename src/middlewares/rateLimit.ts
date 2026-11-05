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

import { Responses } from "../constants/responses";
import { normalizeEmail } from "../helpers";
import { rememberedDeviceSignature } from "../helpers/deviceCookie";
import { wasCodeRejected } from "../helpers/emailCodes";

export const FAILED_ATTEMPTS_WINDOW_MS: number = 15 * 60 * 1000;
export const FAILED_ATTEMPTS_PER_ACCOUNT: number = 10;
export const FAILED_ATTEMPTS_PER_IP: number = 100;
export const FAILED_LOGINS_PER_EMAIL: number = 100;
export const MAIL_SENDS_WINDOW_MS: number = 60 * 60 * 1000;
export const MAIL_SENDS_PER_IP: number = 10;
export const USERNAME_CHECKS_WINDOW_MS: number = 60 * 1000;
export const USERNAME_CHECKS_PER_IP: number = 30;

const failedAttemptStatuses: number[] = [403, 404];

const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value !== "";

const lacksLoginCredentials = (req: express.Request): boolean =>
    !isNonEmptyString(get(req, "body.email")) || !isNonEmptyString(get(req, "body.password"));

const lacksEmail = (req: express.Request): boolean => !isNonEmptyString(get(req, "body.email"));

const IP_SUBNET: number = 56;
const EMAIL_AND_IP_SUBNET: number = 48;

const ipKey = (ip: string): string => ipKeyGenerator(ip, IP_SUBNET);

const emailKey = (email: string): string =>
    crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");

const emailAndIpKey = (email: string, ip: string): string =>
    `${emailKey(email)}:${ipKeyGenerator(ip, EMAIL_AND_IP_SUBNET)}`;

const byIp = ({ ip }: express.Request): string => ipKey(ip);

const byEmail = (req: express.Request): string => emailKey(get(req, "body.email"));

const byEmailAndIp = ({ body, ip }: express.Request): string =>
    emailAndIpKey(get(body, "email"), ip);

const byEmailAndDevice = async (req: express.Request): Promise<string> => {
    const signature: string | null = await rememberedDeviceSignature(req, get(req, "body.email"));

    return signature ? `${byEmail(req)}:${signature}` : byEmail(req);
};

interface LimitedMessage {
    error: string;
    retryAfter: number;
}

const limitedMessage =
    (error: string): ValueDeterminingMiddleware<LimitedMessage> =>
    (req: express.Request, res: express.Response): LimitedMessage => ({
        error,
        retryAfter: Number(res.getHeader("Retry-After"))
    });

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
        keyGenerator: byIp,
        ...options
    });

const loginPerIp: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, {
    skip: lacksLoginCredentials
});

const loginPerAccount: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
    skip: lacksLoginCredentials,
    keyGenerator: byEmailAndIp
});

const loginPerEmail: RateLimitRequestHandler = limitFailedAttempts(FAILED_LOGINS_PER_EMAIL, {
    skip: lacksLoginCredentials,
    keyGenerator: byEmailAndDevice
});

export const limitLoginAttempts: RateLimitRequestHandler[] = [
    loginPerIp,
    loginPerAccount,
    loginPerEmail
];

const wasCodeAccepted = (req: express.Request, res: express.Response): boolean =>
    !wasCodeRejected(res);

const codeChecksPerIp: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, {
    requestWasSuccessful: wasCodeAccepted
});

const codeChecksPerEmail: RateLimitRequestHandler = limitFailedAttempts(
    FAILED_ATTEMPTS_PER_ACCOUNT,
    {
        skip: lacksEmail,
        keyGenerator: byEmail,
        requestWasSuccessful: wasCodeAccepted
    }
);

export const limitCodeChecks: RateLimitRequestHandler[] = [codeChecksPerIp, codeChecksPerEmail];

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
    message: limitedMessage(Responses.tooManyEmails),
    keyGenerator: byIp
});

export const limitUsernameChecks: RateLimitRequestHandler = rateLimit({
    windowMs: USERNAME_CHECKS_WINDOW_MS,
    limit: USERNAME_CHECKS_PER_IP,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: limitedMessage(Responses.tooManyUsernameChecks),
    keyGenerator: byIp
});

const identityId = (req: express.Request): string => String(get(req, "identity._id"));

const accountCodeChecksPerIp: RateLimitRequestHandler = limitFailedAttempts(
    FAILED_ATTEMPTS_PER_IP,
    { requestWasSuccessful: wasCodeAccepted }
);

export const limitAccountCodeChecks: RateLimitRequestHandler[] = [
    accountCodeChecksPerIp,
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
        keyGenerator: identityId,
        requestWasSuccessful: wasCodeAccepted
    })
];

const passwordChecksPerIp: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_IP);

export const limitPasswordChecks: RateLimitRequestHandler[] = [
    passwordChecksPerIp,
    limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, { keyGenerator: identityId })
];

type LimiterKey = "ip" | "hashedEmail" | "hashedEmailAndIp";

interface NamedLimiter {
    name: string;
    key: LimiterKey;
    limiter: RateLimitRequestHandler;
}

const namedLimiters: NamedLimiter[] = [
    { name: "loginPerIp", key: "ip", limiter: loginPerIp },
    { name: "loginPerAccount", key: "hashedEmailAndIp", limiter: loginPerAccount },
    { name: "loginPerEmail", key: "hashedEmail", limiter: loginPerEmail },
    { name: "codeChecksPerIp", key: "ip", limiter: codeChecksPerIp },
    { name: "codeChecksPerEmail", key: "hashedEmail", limiter: codeChecksPerEmail },
    { name: "resetLinkChecksPerIp", key: "ip", limiter: limitResetLinkChecks },
    { name: "mailSendsPerIp", key: "ip", limiter: limitMailSends },
    { name: "usernameChecksPerIp", key: "ip", limiter: limitUsernameChecks },
    { name: "accountCodeChecksPerIp", key: "ip", limiter: accountCodeChecksPerIp },
    { name: "passwordChecksPerIp", key: "ip", limiter: passwordChecksPerIp }
];

const limiterKeys = (email?: string, ip?: string): Partial<Record<LimiterKey, string>> => ({
    ip: ip === undefined ? undefined : ipKey(ip),
    hashedEmail: email === undefined ? undefined : emailKey(email),
    hashedEmailAndIp: email === undefined || ip === undefined ? undefined : emailAndIpKey(email, ip)
});

export const clearRateLimits = async (email?: string, ip?: string): Promise<string[]> => {
    const keys: Partial<Record<LimiterKey, string>> = limiterKeys(email, ip);
    const cleared: string[] = [];

    for (const { name, key, limiter } of namedLimiters) {
        if (keys[key] !== undefined && (await limiter.getKey(keys[key])) !== undefined) {
            await limiter.resetKey(keys[key]);
            cleared.push(name);
        }
    }

    return cleared;
};
