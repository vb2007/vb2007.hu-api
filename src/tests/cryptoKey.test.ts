import { checkCryptoSecretKey } from "../helpers/cryptoKey";

describe("CRYPTO_SECRET_KEY Tests", (): void => {
    test.each([
        ["unset", undefined],
        ["empty", ""],
        ["whitespace only", "   "],
        ["the published example", "verySecret_@nd_comp1ex_K€y"]
    ])("should refuse a key that is %s", (_: string, key: string | undefined): void => {
        expect(() => checkCryptoSecretKey(key)).toThrow(
            /CRYPTO_SECRET_KEY is missing, empty or the published example.*docs\/dotenv-setup\.md/
        );
    });

    test.each([
        ["a short key", "abc123"],
        ["a generated key", "a".repeat(64)]
    ])("should accept %s", (_: string, key: string): void => {
        expect(checkCryptoSecretKey(key)).toBe(key);
    });

    describe("with a fixed key", (): void => {
        const realKey: string = process.env.CRYPTO_SECRET_KEY;
        let helpers: typeof import("../helpers");
        let apiKeys: typeof import("../helpers/apiKeys");
        let cryptoKey: typeof import("../helpers/cryptoKey");
        let userUploads: typeof import("../helpers/userUploads");
        let mfaTotp: typeof import("../helpers/mfaTotp");

        beforeAll((): void => {
            process.env.CRYPTO_SECRET_KEY = "fixed-vector-test-key";
            jest.isolateModules((): void => {
                helpers = require("../helpers");
                apiKeys = require("../helpers/apiKeys");
                cryptoKey = require("../helpers/cryptoKey");
                userUploads = require("../helpers/userUploads");
                mfaTotp = require("../helpers/mfaTotp");
            });
        });

        afterAll((): void => {
            process.env.CRYPTO_SECRET_KEY = realKey;
        });

        it("should keep the password pepper and API key hashes", (): void => {
            expect(helpers.authentication("fixed-salt", "fixed-password")).toBe(
                "1513ea384f90d4f33a05908c1283a1fb630cc6c96c4a2b6125b5ff6386534e81"
            );
            expect(apiKeys.hashApiKey("vbk_fixedtoken")).toBe(
                "dcd4c60a80a33e685fa55881a55ed12841b2388fce0e1f8b10ddc53446c7f44b"
            );
        });

        it("should keep the upload URL and TOTP subkeys", (): void => {
            expect(cryptoKey.deriveKey("upload-url").toString("hex")).toBe(
                "c09c8f50d70311ebb58fddf585ae998692ade9cefb40497cef5450a3cfdda308"
            );
            expect(cryptoKey.deriveKey("mfa-totp").toString("hex")).toBe(
                "5fd82dd3ca752d42241c3371f75570e8c0ae64a4d1b7b632d8a70194df325c32"
            );
            expect(userUploads.signUploadPath("/useruploads/u/x.png", 2000000000)).toBe(
                "/useruploads/u/x.png?expires=2000000000&sig=fLgaKbbh4nyYgFoAcfF4ns4ka3nG6eglIruNHgG-V5s"
            );
            expect(
                mfaTotp.decryptTotpSecret(
                    "64b000000000000000000001",
                    "9DI5lu3vIN-eufOA.o9TPwRX1dDmlVwG-xVlR6Q.H9Fv2wPAD7GIYcYgvZm0Ww"
                )
            ).toBe("JBSWY3DPEHPK3PXP");
        });
    });
});
