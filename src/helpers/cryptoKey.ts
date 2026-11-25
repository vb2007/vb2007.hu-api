import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const publishedExampleKey: string = "verySecret_@nd_comp1ex_K€y";

export const checkCryptoSecretKey = (key: string | undefined): string => {
    if (!key?.trim() || key === publishedExampleKey) {
        throw new Error(
            "CRYPTO_SECRET_KEY is missing, empty or the published example: generate one with `openssl rand -hex 32`, see docs/dotenv-setup.md"
        );
    }

    return key;
};

checkCryptoSecretKey(process.env.CRYPTO_SECRET_KEY);

export const deriveKey = (purpose: string): Buffer =>
    crypto.createHmac("sha256", process.env.CRYPTO_SECRET_KEY).update(purpose).digest();
