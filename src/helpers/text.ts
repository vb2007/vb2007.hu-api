//helpers for doing things with strings and other text data types
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