import express from "express";

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";

const containsWhitespace = (text: string) => /\s/.test(text);

function generateShortUrl(length: number) {
    const characters = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let randomString: string;

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        randomString += characters[randomIndex];
    }

    return randomString;
}

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const originalUrl = req.body;

        if (!originalUrl.startsWith("https://") || (!originalUrl.startsWith("http://") || containsWhitespace(originalUrl))) {
            res.sendStatus(400).json({ error: "The url you've provided is invalid." });
        }
        
        var shortenedUrl = generateShortUrl(originalUrl);
        const addedBy = "temp_test";
        const addedOn = "temp_test";

        const response = await createShortUrl({
            originalUrl,
            shortenedUrl,
            addedBy,
            addedOn
        });

        res.sendStatus(200).json({ response });
    } catch (error) {
        console.error(error);
        res.sendStatus(500);
    }
}