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
        const url = req.body;

        if (!url.startsWith("https://") || (!url.startsWith("http://") || containsWhitespace(url))) {
            res.sendStatus(400).json({ error: "The url you've provided is invalid." });
        }
        
        var shortenedUrl = generateShortUrl(url);

        await createShortUrl(shortenedUrl);

        res.sendStatus(200).json({ shortenedUrl : shortenedUrl })
    } catch (error) {
        console.error(error);
        res.sendStatus(500);
    }
}