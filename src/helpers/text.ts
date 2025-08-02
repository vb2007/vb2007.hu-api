import { sample, times } from "lodash";

const ALPHANUMERIC_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const validURIType: string[] = [
    "acap://",
    "app://",
    "file://",
    "ftp://",
    "ftps://",
    "http://",
    "https://",
    "icap://",
    "imap://",
    "irc://",
    "mailto:",
    "ms-access:",
    "ms-excel:",
    "ms-infopath:",
    "ms-powerpoint:",
    "ms-project:",
    "ms-publisher:",
    "ms-spd:",
    "ms-visio:",
    "ms-word:",
    "msteams://",
    "mtqp://",
    "nntp://",
    "pop://",
    "rsync://",
    "rtmp://",
    "rtsp://",
    "sftp://",
    "shortcuts://",
    "smb://",
    "smtp://",
    "ssh://",
    "telnet://",
    "viber://",
    "webcal://",
    "wss://",
    "xmpp://",
    "zoomus://",
    "zoommtg://"
];

export const containsWhitespace = (text: string): boolean => /\s/.test(text);

export const generateRandomString = (length: number): string => {
    return times(length, () => sample(ALPHANUMERIC_CHARS)).join("");
};

export const validateUri = (url: string): boolean => {
    return validURIType.some(
        (uriType) => url.toLowerCase().startsWith(uriType.toLowerCase()) && !containsWhitespace(url)
    );
};

export const generateUniqueString = (length: number = 8): string => {
    const timestamp = Date.now().toString(36); //timestamp -> base36

    if (length <= timestamp.length) {
        return timestamp.substring(0, length);
    }

    const remainingLength = length - timestamp.length;
    const randomPart = times(remainingLength, () => sample(ALPHANUMERIC_CHARS)).join("");

    return timestamp + randomPart;
};
