import express from "express";

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";

const containsWhitespace = (text: string) => /\s/.test(text);

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const url = req.body;

        if (!url.startsWith("https://") || (!url.startsWith("http://") || containsWhitespace(url))) {
            res.sendStatus(400).json({ error: "The url you've provided is invalid." });
        }
        
        
    } catch (error) {
        console.error(error);
        res.sendStatus(500);
    }
}