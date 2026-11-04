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

const EMAIL_MAX_LENGTH: number = 254;
const EMAIL_ATOM: string = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+/.source;
const EMAIL_DOMAIN_LABEL: string = /[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?/.source;
const EMAIL_PATTERN: RegExp = new RegExp(
    `^${EMAIL_ATOM}(?:\\.${EMAIL_ATOM})*@${EMAIL_DOMAIN_LABEL}(?:\\.${EMAIL_DOMAIN_LABEL})+$`
);

export const isValidEmail = (email: string): boolean =>
    email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);

export const isSuperuserEmail = (email: string): boolean => {
    const superuserEmail: string = normalizeEmail(process.env.SUPERUSER_EMAIL ?? "");

    return superuserEmail !== "" && normalizeEmail(email ?? "") === superuserEmail;
};

const PASSWORD_MIN_LENGTH: number = 8;
const PASSWORD_MAX_LENGTH: number = 128;

export const passwordLengthError = (password: string): string | null => {
    const length: number = [...password].length;

    if (length < PASSWORD_MIN_LENGTH) {
        return Responses.Authentication.passwordTooShort;
    }

    if (length > PASSWORD_MAX_LENGTH) {
        return Responses.Authentication.passwordTooLong;
    }

    return null;
};
