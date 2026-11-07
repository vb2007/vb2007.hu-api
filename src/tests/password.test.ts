import crypto from "crypto";

import { authentication, random } from "../helpers";
import {
    hashPassword,
    isLegacyPasswordHash,
    verifyLoginPassword,
    verifyPassword,
    wrapLegacyPasswordHash
} from "../helpers/password";

describe("Password Hashing Tests", (): void => {
    const password: string = "correct horse battery staple";
    const wrongPassword: string = `${password}!`;
    const client: string = "client";
    const afterQueued = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const finishScryptsInStartOrder = () =>
        jest.spyOn(crypto, "scrypt").mockImplementation(((...args: unknown[]): void => {
            const done = args[args.length - 1] as (error: null, key: Buffer) => void;
            setImmediate(() => done(null, Buffer.alloc(64)));
        }) as typeof crypto.scrypt);
    let salt: string;
    let stored: string;

    beforeAll(async (): Promise<void> => {
        salt = random();
        stored = await hashPassword(salt, password, client);
        await verifyLoginPassword(undefined, undefined, password, client);
    });

    it("should store scrypt hashes with their parameters", (): void => {
        expect(stored).toMatch(/^scrypt\$16384\$8\$5\$[0-9a-f]{128}$/);
        expect(isLegacyPasswordHash(stored)).toBe(false);
    });

    it("should verify the right password", async (): Promise<void> => {
        await expect(verifyPassword(salt, stored, password, client)).resolves.toBe(true);
    });

    it("should reject a wrong password or salt", async (): Promise<void> => {
        await expect(verifyPassword(salt, stored, wrongPassword, client)).resolves.toBe(false);
        await expect(verifyPassword(random(), stored, password, client)).resolves.toBe(false);
    });

    it("should hash the same password differently with a fresh salt", async (): Promise<void> => {
        expect(await hashPassword(random(), password, client)).not.toBe(stored);
    });

    it("should verify legacy HMAC hashes", async (): Promise<void> => {
        const legacy: string = authentication(salt, password);

        expect(isLegacyPasswordHash(legacy)).toBe(true);
        await expect(verifyPassword(salt, legacy, password, client)).resolves.toBe(true);
        await expect(verifyPassword(salt, legacy, wrongPassword, client)).resolves.toBe(false);
        await expect(verifyPassword(salt, `${legacy}zz`, password, client)).resolves.toBe(false);
        await expect(verifyPassword(salt, legacy.slice(2), password, client)).resolves.toBe(false);
    });

    it("should wrap a legacy HMAC hash into the scrypt hash of the same password", async (): Promise<void> => {
        const legacy: string = authentication(salt, password);
        const wrapped: string = await wrapLegacyPasswordHash(salt, legacy, client);
        const key: Buffer = crypto.scryptSync(legacy, salt, 64, { N: 16384, r: 8, p: 5 });

        expect(wrapped).toBe(`scrypt$16384$8$5$${key.toString("hex")}`);
        await expect(verifyPassword(salt, wrapped, password, client)).resolves.toBe(true);
        await expect(verifyPassword(salt, wrapped, wrongPassword, client)).resolves.toBe(false);
    });

    it("should hash the password's HMAC with CRYPTO_SECRET_KEY rather than the password", (): void => {
        const hashWithSecret = (secret: string): string => {
            const pepperedPassword: string = crypto
                .createHmac("sha256", [salt, password].join("/"))
                .update(secret)
                .digest("hex");
            const key: Buffer = crypto.scryptSync(pepperedPassword, salt, 64, {
                N: 16384,
                r: 8,
                p: 5
            });

            return `scrypt$16384$8$5$${key.toString("hex")}`;
        };
        const secret: string = process.env.CRYPTO_SECRET_KEY;

        expect(secret).toBeTruthy();
        expect(stored).toBe(hashWithSecret(secret));
        expect(stored).not.toBe(hashWithSecret(`${secret}-other`));
    });

    it("should reject hashes with other parameters without running them", async (): Promise<void> => {
        const hex: string = stored.split("$")[4];
        const otherParameters: string[] = [
            `scrypt$16384$8$2000$${hex}`,
            `scrypt$32768$8$5$${hex}`,
            `scrypt$16384$16$5$${hex}`,
            `scrypt$16384$8$1$${hex}`
        ];
        const startedAt: number = Date.now();

        for (const hash of otherParameters) {
            await expect(verifyPassword(salt, hash, password, client)).resolves.toBe(false);
        }

        expect(Date.now() - startedAt).toBeLessThan(1000);
    });

    it("should not queue a client's failed login behind another client's burst of them", async (): Promise<void> => {
        const scrypt = finishScryptsInStartOrder();
        const finished: string[] = [];
        const failedLogin = (loginClient: string): Promise<number> =>
            verifyLoginPassword(undefined, undefined, wrongPassword, loginClient).then(() =>
                finished.push(loginClient)
            );

        try {
            const burst: Promise<number>[] = Array.from({ length: 200 }, () =>
                failedLogin("burst")
            );
            await afterQueued();

            await Promise.all([...burst, failedLogin(client)]);

            expect(finished.indexOf(client)).toBeLessThan(burst.length / 2);
        } finally {
            scrypt.mockRestore();
        }
    });

    it("should queue failed logins for existing and unknown addresses alike", async (): Promise<void> => {
        const scrypt = finishScryptsInStartOrder();
        const finished: string[] = [];
        const failedLogin = (
            loginSalt: string | undefined,
            loginStored: string | undefined,
            loginClient: string
        ): Promise<number> =>
            verifyLoginPassword(loginSalt, loginStored, wrongPassword, loginClient).then(() =>
                finished.push(loginClient)
            );

        try {
            const unknown: Promise<number>[] = Array.from({ length: 200 }, () =>
                failedLogin(undefined, undefined, "unknown")
            );
            await afterQueued();
            const existing: Promise<number>[] = Array.from({ length: 200 }, () =>
                failedLogin(random(), stored, "existing")
            );

            await Promise.all([...unknown, ...existing]);

            const firstHalf: string[] = finished.slice(0, finished.length / 2);
            expect(firstHalf.filter((done) => done === "existing").length).toBeGreaterThanOrEqual(
                existing.length / 4
            );
        } finally {
            scrypt.mockRestore();
        }
    });

    it("should reject malformed or length-mismatched scrypt hashes", async (): Promise<void> => {
        const [prefix, cost, blockSize, parallelization, hex] = stored.split("$");
        const malformed: string[] = [
            "scrypt$",
            `${prefix}$${cost}$${blockSize}$${parallelization}`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$${hex}$`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$${hex.slice(1)}`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$${hex.slice(2)}`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$${hex}00`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$${hex.toUpperCase()}`,
            `${prefix}$x$${blockSize}$${parallelization}$${hex}`,
            `${prefix}$0$${blockSize}$${parallelization}$${hex}`,
            `${prefix}$3$${blockSize}$${parallelization}$${hex}`,
            `${prefix}$${cost}$${blockSize}$${parallelization}$${hex.replace(/^./, "g")}`
        ];

        for (const hash of malformed) {
            await expect(verifyPassword(salt, hash, password, client)).resolves.toBe(false);
        }
    });

    it("should check login passwords and reject a missing account or password", async (): Promise<void> => {
        const legacy: string = authentication(salt, password);

        await expect(verifyLoginPassword(salt, stored, password, client)).resolves.toBe(true);
        await expect(verifyLoginPassword(salt, stored, wrongPassword, client)).resolves.toBe(false);
        await expect(verifyLoginPassword(salt, legacy, password, client)).resolves.toBe(true);
        await expect(verifyLoginPassword(salt, legacy, wrongPassword, client)).resolves.toBe(false);
        await expect(verifyLoginPassword(undefined, undefined, password, client)).resolves.toBe(
            false
        );
        await expect(verifyLoginPassword(salt, "", password, client)).resolves.toBe(false);
    });

    it("should run scrypt exactly once for every failed login", async (): Promise<void> => {
        const legacy: string = authentication(salt, password);
        await verifyLoginPassword(undefined, undefined, wrongPassword, client);
        const scrypt = jest.spyOn(crypto, "scrypt");

        try {
            for (const [loginSalt, loginStored] of [
                [undefined, undefined],
                [salt, ""],
                [salt, legacy],
                [salt, stored]
            ]) {
                scrypt.mockClear();
                await expect(
                    verifyLoginPassword(loginSalt, loginStored, wrongPassword, client)
                ).resolves.toBe(false);
                expect(scrypt).toHaveBeenCalledTimes(1);
            }
        } finally {
            scrypt.mockRestore();
        }
    });
});
