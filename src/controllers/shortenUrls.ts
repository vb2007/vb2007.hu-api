import express from "express";

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";

const containsWhitespace = (text: string) => /\s/.test(text);

function generateShortUrl(length: number) {
    const characters = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let randomString:string = "";

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        randomString += characters[randomIndex];
    }

    return randomString;
}

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        console.log(url);

        // if (!url.startsWith("https://") || (!url.startsWith("http://") || containsWhitespace(url))) {
        //     return res.sendStatus(400);
        // }
        
        var shortenedUrl = generateShortUrl(4);
        console.log(shortenedUrl);
        // const addedBy = "temp_test";
        // const addedOn = "temp_test";

        let originalUrl = url;
        const response = await createShortUrl({
            originalUrl,
            shortenedUrl
        });

        return res.sendStatus(200).json(response);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}