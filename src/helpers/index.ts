//authentication helpers
import crypto from "crypto";
import dotenv from "dotenv";
import { Responses } from "../constants/responses";
dotenv.config();

const SECRET: string = process.env.CRYPTO_SECRET_KEY;

export const random = (): string => crypto.randomBytes(128).toString("base64");

export const authentication = (salt: string, password: string): string =>
    crypto.createHmac("sha256", [salt, password].join("/")).update(SECRET).digest("hex");

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const isSuperuserEmail = (email: string): boolean => {
    const superuserEmail: string = normalizeEmail(process.env.SUPERUSER_EMAIL ?? "");

    return superuserEmail !== "" && normalizeEmail(email ?? "") === superuserEmail;
};

export const PASSWORD_MIN_LENGTH: number = 8;
export const PASSWORD_MAX_LENGTH: number = 128;

export const validatePassword = (password: string): string | null => {
    const length: number = [...password].length;

    if (length < PASSWORD_MIN_LENGTH) {
        return Responses.Authentication.passwordTooShort;
    }

    if (length > PASSWORD_MAX_LENGTH) {
        return Responses.Authentication.passwordTooLong;
    }

    return null;
};
