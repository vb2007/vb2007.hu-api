import express from "express";
import { get } from "lodash";

import { getOriginalUrl, getShortUrl, createShortUrl } from "../database/shortUrls";
import { generateShortUrl, validateUri } from "../helpers/text";

export const shortenUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        const currentUserId = get(req, 'identity._id') as string;
        
        if (!validateUri(url)) {
            return res.sendStatus(400);
        }

        const existingShortUrl = await getShortUrl(url);
        if (existingShortUrl) {
            return res.status(200).json(existingShortUrl);
        }

        var shortenedUrl = generateShortUrl(4);

        let originalUrl:string = url;
        const response = await createShortUrl({
            originalUrl,
            shortenedUrl,
            addedBy: currentUserId
        });

        return res.status(201).json(response);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const redirectToOriginalUrl = async(req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.params;

        const response = await getOriginalUrl(shortenedUrl);

        return res.status(302).redirect(response.originalUrl);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}