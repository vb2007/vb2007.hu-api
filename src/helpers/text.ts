//helpers for doing things with strings and other text data types

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

export const containsWhitespace = (text: string) => /\s/.test(text);

export function generateShortUrl(length: number) {
    const characters = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let randomString:string = "";

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        randomString += characters[randomIndex];
    }

    return randomString;
}

export function validateUri(url: string) {
    return validURIType.some(uriType => url.toLowerCase().startsWith(uriType.toLowerCase())
        && !containsWhitespace(url));
}