import express from "express";

import { getOriginalUrl, createShortUrl } from "../database/shortUrls";
import { generateShortUrl, validateUri } from "../helpers/text";

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        const user = req.identity;
        
        if (!validateUri(url)) {
            return res.sendStatus(400);
        }

        var shortenedUrl = generateShortUrl(4);

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

export const redirectToOriginalUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.params;

        const response = await getOriginalUrl(shortenedUrl);

        return res.redirect(response.originalUrl);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}