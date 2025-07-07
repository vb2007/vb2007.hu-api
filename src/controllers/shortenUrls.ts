import express from "express";
import { get } from "lodash";

import {
    getOriginalUrl,
    getShortUrl,
    createShortUrl,
    deleteByShortUrl
} from "../database/shortUrls";
import { generateRandomString, validateUri } from "../helpers/text";

export const shortenUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        const currentUserId = get(req, "identity._id") as string;

        if (!validateUri(url)) {
            return res.status(400).json({ error: "The URI/URL you've provided isn't valid." });
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
            return res.status(400).json({ error: "You must specify a shortened URL." });
        }

        const response = await getOriginalUrl(shortenedUrl);

        if (!response) {
            return res
                .status(404)
                .json({ error: "The shortened URL you've requested cannot be found." });
        }

        return res.status(302).redirect(response.originalUrl);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const deleteUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.body;

        if (!shortenUrl) {
            return res.status(400).json({ error: "You must specify a shortened URL." });
        }

        const response = await deleteByShortUrl(shortenedUrl);

        if (!response) {
            await res.status(404).json({ error: "The shortened URL cannot be found." });
        }

        return res.status(200).json({ message: "Shortened URL deleted successfully." });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
