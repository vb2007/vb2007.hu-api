import express from "express";

declare global {
    namespace Express {
        interface Request {
            identity?: any;
        }
    }
}

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";
import { generateShortUrl, validateUri } from "../helpers/text";

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        const user = req.identity;
        console.log(url);
        
        if (!validateUri(url)) {
            return res.sendStatus(400);
        }

        var shortenedUrl = generateShortUrl(4);
        console.log(shortenedUrl);
        // const addedBy = "temp_test";

        let originalUrl:string = url;
        const response = await createShortUrl({
            originalUrl,
            shortenedUrl,
            addedBy: user.username
        });

        return res.status(200).json(response);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}