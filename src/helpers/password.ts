import crypto from "crypto";

import { authentication, random } from ".";

const SCRYPT_PREFIX: string = "scrypt";
const SCRYPT_COST: number = 16384;
const SCRYPT_BLOCK_SIZE: number = 8;
const SCRYPT_PARALLELIZATION: number = 5;
const SCRYPT_KEY_LENGTH: number = 64;

const hexPattern: RegExp = /^(?:[0-9a-f]{2})+$/;
const integerPattern: RegExp = /^[1-9]\d*$/;

const scrypt = (
    salt: string,
    password: string,
    keyLength: number,
    options: crypto.ScryptOptions
): Promise<Buffer> =>
    new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, keyLength, options, (error, key) =>
            error ? reject(error) : resolve(key)
        )
    );

const isEqual = (expected: Buffer, actual: Buffer): boolean =>
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

export const hashPassword = async (salt: string, password: string): Promise<string> => {
    const key: Buffer = await scrypt(salt, password, SCRYPT_KEY_LENGTH, {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION
    });

    return [
        SCRYPT_PREFIX,
        SCRYPT_COST,
        SCRYPT_BLOCK_SIZE,
        SCRYPT_PARALLELIZATION,
        key.toString("hex")
    ].join("$");
};

export const isLegacyPasswordHash = (stored: string): boolean =>
    !stored.startsWith(`${SCRYPT_PREFIX}$`);

const verifyScryptPassword = async (
    salt: string,
    stored: string,
    password: string
): Promise<boolean> => {
    const [, cost, blockSize, parallelization, hex, ...rest] = stored.split("$");
    const parameters: string[] = [cost, blockSize, parallelization];

    if (
        rest.length > 0 ||
        !hexPattern.test(hex ?? "") ||
        !parameters.every((parameter) => integerPattern.test(parameter ?? ""))
    ) {
        return false;
    }

    const expected: Buffer = Buffer.from(hex, "hex");

    try {
        const [N, r, p] = parameters.map(Number);
        return isEqual(expected, await scrypt(salt, password, expected.length, { N, r, p }));
    } catch {
        return false;
    }
};

export const verifyPassword = (salt: string, stored: string, password: string): Promise<boolean> =>
    isLegacyPasswordHash(stored)
        ? Promise.resolve(isEqual(Buffer.from(stored), Buffer.from(authentication(salt, password))))
        : verifyScryptPassword(salt, stored, password);

const dummyPasswordHash: Promise<string> = hashPassword(random(), random());
dummyPasswordHash.catch(console.error);

export const verifyLoginPassword = async (
    salt: string | undefined,
    stored: string | undefined,
    password: string
): Promise<boolean> => {
    if (stored && !isLegacyPasswordHash(stored)) {
        return verifyPassword(salt, stored, password);
    }

    await verifyPassword(random(), await dummyPasswordHash, password);

    return Boolean(stored) && verifyPassword(salt, stored, password);
};
