import express from "express";

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";
import { containsWhitespace, generateShortUrl } from "../helpers/text";

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        console.log(url);
        
        if (!url.startsWith("https://") && !url.startsWith("http://") && !url.startsWith("ftp://") || containsWhitespace(url)) {
            return res.sendStatus(400);
        }

        var shortenedUrl = generateShortUrl(4);
        console.log(shortenedUrl);
        // const addedBy = "temp_test";

        let originalUrl:string = url;
        const response = await createShortUrl({
            originalUrl,
            shortenedUrl
        });

        return res.status(200).json(response);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}