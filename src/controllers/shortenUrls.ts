import express from "express";
import { get } from "lodash";

import { getOriginalUrl, getShortUrl, createShortUrl } from "../database/shortUrls";
import { generateRandomString, validateUri } from "../helpers/text";

export const shortenUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        const currentUserId = get(req, "identity._id") as string;

        if (!validateUri(url)) {
            return res.send(400).json({ error: "The URI/URL you've provided isn't valid." });
        }

        const existingShortUrl = await getShortUrl(url);
        if (existingShortUrl) {
            return res.status(200).json(existingShortUrl);
        }

        let shortenedString: string = generateRandomString(4);
        let originalUrl: string = url;
        const shortenedUrl = await createShortUrl({
            originalUrl: originalUrl,
            shortenedUrl: shortenedString,
            addedBy: currentUserId
        });

        const finalResponse: Object = {
            message: "URL shortened successfully",
            shortenedUrl: shortenedUrl.shortenedUrl,
            originalUrl: shortenedUrl.originalUrl,
            addedOn: shortenedUrl.addedOn,
            addedBy: shortenedUrl.addedBy
        };

        return res.status(201).json(finalResponse);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const redirectToOriginalUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.params;

        if (!shortenUrl) {
            return res.send(400).json({ error: "You must specify a shortened URL." });
        }

        const response = await getOriginalUrl(shortenedUrl);

        if (!response) {
            return res
                .send(404)
                .json({ error: "The shortened URL you've requested cannot be found." });
        }

        return res.status(302).redirect(response.originalUrl);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
