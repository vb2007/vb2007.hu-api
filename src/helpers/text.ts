//helpers for doing things with strings and other text data types

import crypto from "crypto";

const characters: string = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const validURIType: string[] = [
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

//used the most for url generation
export const generateRandomString = (length: number): string => {
    let randomString: string = "";

    for (let i: number = 0; i < length; i++) {
        randomString += characters[crypto.randomInt(characters.length)];
    }

    return randomString;
};

export const validateUri = (url: string): boolean =>
    validURIType.some(
        (uriType: string): boolean =>
            url.toLowerCase().startsWith(uriType.toLowerCase()) && !containsWhitespace(url)
    );
