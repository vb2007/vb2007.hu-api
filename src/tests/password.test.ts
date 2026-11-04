import { authentication, random } from "../helpers";
import { hashPassword, isLegacyPasswordHash, verifyPassword } from "../helpers/password";

describe("Password Hashing Tests", (): void => {
    const password: string = "correct horse battery staple";
    let salt: string;
    let stored: string;

    beforeAll(async (): Promise<void> => {
        salt = random();
        stored = await hashPassword(salt, password);
    });

    it("should store scrypt hashes with their parameters", (): void => {
        expect(stored).toMatch(/^scrypt\$16384\$8\$5\$[0-9a-f]{128}$/);
        expect(isLegacyPasswordHash(stored)).toBe(false);
    });

    it("should verify the right password", async (): Promise<void> => {
        await expect(verifyPassword(salt, stored, password)).resolves.toBe(true);
    });

    it("should reject a wrong password or salt", async (): Promise<void> => {
        await expect(verifyPassword(salt, stored, `${password}!`)).resolves.toBe(false);
        await expect(verifyPassword(random(), stored, password)).resolves.toBe(false);
    });

    it("should hash the same password differently with a fresh salt", async (): Promise<void> => {
        expect(await hashPassword(random(), password)).not.toBe(stored);
    });

    it("should verify legacy HMAC hashes", async (): Promise<void> => {
        const legacy: string = authentication(salt, password);

        expect(isLegacyPasswordHash(legacy)).toBe(true);
        await expect(verifyPassword(salt, legacy, password)).resolves.toBe(true);
        await expect(verifyPassword(salt, legacy, `${password}!`)).resolves.toBe(false);
        await expect(verifyPassword(salt, `${legacy}zz`, password)).resolves.toBe(false);
        await expect(verifyPassword(salt, legacy.slice(2), password)).resolves.toBe(false);
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
            await expect(verifyPassword(salt, hash, password)).resolves.toBe(false);
        }
    });
});
