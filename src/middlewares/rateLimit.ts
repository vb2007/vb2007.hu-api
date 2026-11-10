import express from "express";
import crypto from "crypto";
import {
    ClientRateLimitInfo,
    MemoryStore,
    Options,
    RateLimitRequestHandler,
    ValueDeterminingMiddleware,
    ipKeyGenerator,
    rateLimit
} from "express-rate-limit";
import { get } from "lodash";

import {
    EMAIL_AND_IP_SUBNET,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    FAILED_ATTEMPTS_PER_IP,
    FAILED_ATTEMPTS_WINDOW_MS,
    FAILED_LOGINS_PER_EMAIL,
    IP_SUBNET,
    MAIL_SENDS_PER_IP,
    MAIL_SENDS_WINDOW_MS,
    USERNAME_CHECKS_PER_IP,
    USERNAME_CHECKS_WINDOW_MS
} from "../constants/limits";
import { Responses } from "../constants/responses";
import { isNonEmptyString, normalizeEmail } from "../helpers";
import { rememberedDeviceSignature } from "../helpers/deviceCookie";
import { wasCodeRejected } from "../helpers/emailCodes";

const failedAttemptStatuses: number[] = [403, 404];

const lacksLoginCredentials = (req: express.Request): boolean =>
    !isNonEmptyString(get(req, "body.email")) || !isNonEmptyString(get(req, "body.password"));

const lacksEmail = (req: express.Request): boolean => !isNonEmptyString(get(req, "body.email"));

export const ipKey = (ip: string): string => ipKeyGenerator(ip, IP_SUBNET);

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
        keyGenerator: byIp,
        ...options
    });

const loginPerIp: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_IP, {
    skip: lacksLoginCredentials
});

const loginPerAccountStore: MemoryStore = new MemoryStore();

const loginPerAccount: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_ACCOUNT, {
    skip: lacksLoginCredentials,
    keyGenerator: byEmailAndIp,
    store: loginPerAccountStore
});

const loginPerEmailStore: MemoryStore = new MemoryStore();

const loginPerEmail: RateLimitRequestHandler = limitFailedAttempts(FAILED_LOGINS_PER_EMAIL, {
    skip: lacksLoginCredentials,
    keyGenerator: byEmailAndDevice,
    standardHeaders: false,
    store: loginPerEmailStore
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
        standardHeaders: false,
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

const accountCodeChecksPerAccount: RateLimitRequestHandler = limitFailedAttempts(
    FAILED_ATTEMPTS_PER_ACCOUNT,
    { keyGenerator: identityId, requestWasSuccessful: wasCodeAccepted }
);

export const limitAccountCodeChecks: RateLimitRequestHandler[] = [
    accountCodeChecksPerIp,
    accountCodeChecksPerAccount
];

const passwordChecksPerIp: RateLimitRequestHandler = limitFailedAttempts(FAILED_ATTEMPTS_PER_IP);

const passwordChecksPerAccount: RateLimitRequestHandler = limitFailedAttempts(
    FAILED_ATTEMPTS_PER_ACCOUNT,
    { keyGenerator: identityId }
);

export const limitPasswordChecks: RateLimitRequestHandler[] = [
    passwordChecksPerIp,
    passwordChecksPerAccount
];

type LimiterKey = "ip" | "hashedEmail" | "hashedEmailAndIp" | "userId";

interface EmailPrefixedKeys {
    store: MemoryStore;
    withIp: boolean;
}

interface NamedLimiter {
    name: string;
    key: LimiterKey;
    limiter: RateLimitRequestHandler;
    emailPrefixedKeys?: EmailPrefixedKeys;
}

const namedLimiters: NamedLimiter[] = [
    { name: "loginPerIp", key: "ip", limiter: loginPerIp },
    {
        name: "loginPerAccount",
        key: "hashedEmailAndIp",
        limiter: loginPerAccount,
        emailPrefixedKeys: { store: loginPerAccountStore, withIp: false }
    },
    {
        name: "loginPerEmail",
        key: "hashedEmail",
        limiter: loginPerEmail,
        emailPrefixedKeys: { store: loginPerEmailStore, withIp: true }
    },
    { name: "codeChecksPerIp", key: "ip", limiter: codeChecksPerIp },
    { name: "codeChecksPerEmail", key: "hashedEmail", limiter: codeChecksPerEmail },
    { name: "resetLinkChecksPerIp", key: "ip", limiter: limitResetLinkChecks },
    { name: "mailSendsPerIp", key: "ip", limiter: limitMailSends },
    { name: "usernameChecksPerIp", key: "ip", limiter: limitUsernameChecks },
    { name: "accountCodeChecksPerIp", key: "ip", limiter: accountCodeChecksPerIp },
    { name: "accountCodeChecksPerAccount", key: "userId", limiter: accountCodeChecksPerAccount },
    { name: "passwordChecksPerIp", key: "ip", limiter: passwordChecksPerIp },
    { name: "passwordChecksPerAccount", key: "userId", limiter: passwordChecksPerAccount }
];

const limiterKeys = (
    email?: string,
    ip?: string,
    userId?: string
): Partial<Record<LimiterKey, string>> => ({
    ip: ip === undefined ? undefined : ipKey(ip),
    hashedEmail: email === undefined ? undefined : emailKey(email),
    hashedEmailAndIp:
        email === undefined || ip === undefined ? undefined : emailAndIpKey(email, ip),
    userId
});

const isCounting = (entry: ClientRateLimitInfo | undefined): boolean =>
    entry !== undefined && entry.totalHits > 0 && entry.resetTime > new Date();

const keysToClear = (
    { key, emailPrefixedKeys }: NamedLimiter,
    keys: Partial<Record<LimiterKey, string>>,
    email?: string,
    ip?: string
): string[] => {
    const exactKey: string | undefined = keys[key];
    const toClear: Set<string> = new Set(exactKey === undefined ? [] : [exactKey]);

    if (
        email !== undefined &&
        emailPrefixedKeys &&
        (emailPrefixedKeys.withIp || ip === undefined)
    ) {
        const prefix: string = `${emailKey(email)}:`;
        const { current, previous } = emailPrefixedKeys.store;

        for (const storedKey of [...current.keys(), ...previous.keys()]) {
            if (storedKey.startsWith(prefix)) {
                toClear.add(storedKey);
            }
        }
    }

    return [...toClear];
};

export const clearRateLimits = async (
    email?: string,
    ip?: string,
    userId?: string
): Promise<string[]> => {
    const keys: Partial<Record<LimiterKey, string>> = limiterKeys(email, ip, userId);
    const cleared: string[] = [];

    for (const namedLimiter of namedLimiters) {
        let wasCounting: boolean = false;

        for (const limiterKey of keysToClear(namedLimiter, keys, email, ip)) {
            wasCounting ||= isCounting(await namedLimiter.limiter.getKey(limiterKey));
            await namedLimiter.limiter.resetKey(limiterKey);
        }

        if (wasCounting) {
            cleared.push(namedLimiter.name);
        }
    }

    return cleared;
};
