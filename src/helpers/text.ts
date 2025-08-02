import { sample, times } from "lodash";

import { ALPHANUMERIC_CHARS, validURIType } from "../constants/text";

export const containsWhitespace = (text: string): boolean => /\s/.test(text);

export const generateRandomString = (length: number): string => {
    return times(length, () => sample(ALPHANUMERIC_CHARS)).join("");
};

export const validateUri = (url: string): boolean => {
    return validURIType.some(
        (uriType) => url.toLowerCase().startsWith(uriType.toLowerCase()) && !containsWhitespace(url)
    );
};

export const generateLicenseKey = (userId: string): string => {
    const userIdHash = userId
        .split("")
        .reduce((hash, char) => {
            return hash + char.charCodeAt(0);
        }, 0)
        .toString(36);

    const timestamp = Date.now().toString(36);
    const userPrefix = userId.substring(0, 4).toUpperCase();
    const randomSuffix = times(8, () => sample(ALPHANUMERIC_CHARS)).join("");

    return `${userPrefix}-${userIdHash}${timestamp}-${randomSuffix}`.toUpperCase();
};
