import crypto from "crypto";

import { authentication } from ".";

const SCRYPT_PREFIX: string = "scrypt";
const SCRYPT_COST: number = 16384;
const SCRYPT_BLOCK_SIZE: number = 8;
const SCRYPT_PARALLELIZATION: number = 5;
const SCRYPT_KEY_LENGTH: number = 64;

const scryptHashPattern: RegExp = new RegExp(
    `^${SCRYPT_PREFIX}\\$${SCRYPT_COST}\\$${SCRYPT_BLOCK_SIZE}\\$${SCRYPT_PARALLELIZATION}\\$([0-9a-f]{${SCRYPT_KEY_LENGTH * 2}})$`
);

const DEFAULT_THREAD_POOL_SIZE: number = 4;
const THREADS_LEFT_FOR_IO: number = 2;
const maxConcurrentScrypts: number = Math.max(
    1,
    (Number(process.env.UV_THREADPOOL_SIZE) || DEFAULT_THREAD_POOL_SIZE) - THREADS_LEFT_FOR_IO
);

let runningScrypts: number = 0;
const waitingScrypts: (() => void)[] = [];

const acquireScrypt = (): Promise<void> => {
    if (runningScrypts < maxConcurrentScrypts) {
        runningScrypts++;
        return Promise.resolve();
    }

    return new Promise((resolve) => waitingScrypts.push(resolve));
};

const releaseScrypt = (): void => {
    const next: (() => void) | undefined = waitingScrypts.shift();

    if (next) {
        next();
    } else {
        runningScrypts--;
    }
};

const scrypt = async (salt: string, input: string): Promise<Buffer> => {
    await acquireScrypt();

    try {
        return await new Promise((resolve, reject) =>
            crypto.scrypt(
                input,
                salt,
                SCRYPT_KEY_LENGTH,
                { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
                (error, key) => (error ? reject(error) : resolve(key))
            )
        );
    } finally {
        releaseScrypt();
    }
};

const isEqual = (expected: Buffer, actual: Buffer): boolean =>
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

export const wrapLegacyPasswordHash = async (salt: string, legacyHash: string): Promise<string> =>
    [
        SCRYPT_PREFIX,
        SCRYPT_COST,
        SCRYPT_BLOCK_SIZE,
        SCRYPT_PARALLELIZATION,
        (await scrypt(salt, legacyHash)).toString("hex")
    ].join("$");

export const hashPassword = (salt: string, password: string): Promise<string> =>
    wrapLegacyPasswordHash(salt, authentication(salt, password));

export const isLegacyPasswordHash = (stored: string): boolean =>
    !stored.startsWith(`${SCRYPT_PREFIX}$`);

const verifyScryptPassword = async (
    salt: string,
    stored: string,
    password: string
): Promise<boolean> => {
    const hex: string | undefined = scryptHashPattern.exec(stored)?.[1];

    if (!hex) {
        return false;
    }

    try {
        return isEqual(Buffer.from(hex, "hex"), await scrypt(salt, authentication(salt, password)));
    } catch {
        return false;
    }
};

export const verifyPassword = (salt: string, stored: string, password: string): Promise<boolean> =>
    isLegacyPasswordHash(stored)
        ? Promise.resolve(isEqual(Buffer.from(stored), Buffer.from(authentication(salt, password))))
        : verifyScryptPassword(salt, stored, password);
