import express from "express";
import { get } from "lodash";

import {
    getOriginalUrl as getOriginalUrlDb,
    getOriginalUrlWithUser,
    getShortUrlByUser,
    createShortUrl,
    deleteByShortUrl
} from "../database/shortUrls";
import { getUserById } from "../database/users";
import { generateRandomString, validateUri } from "../helpers/text";
import { isDuplicateKeyError } from "../helpers/mongoose";
import { Responses } from "../constants/responses";

type ShortUrlData = {
    shortenedUrl: string;
    originalUrl: string;
    addedOn: Date;
    addedBy: unknown;
};

const shortUrlResponse = (
    message: string,
    { shortenedUrl, originalUrl, addedOn, addedBy }: ShortUrlData
): Object => ({
    message,
    data: { shortenedUrl, originalUrl, addedOn, addedBy }
});

export const shortenUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { url } = req.body;
        const currentUserId = get(req, "identity._id") as string;

        if (typeof url !== "string" || !validateUri(url)) {
            return res.status(400).json({ error: Responses.ShortenUrl.invalidUrl });
        }

        const existingShortUrl = await getShortUrlByUser(url, currentUserId);
        if (existingShortUrl) {
            return res
                .status(200)
                .json(shortUrlResponse(Responses.ShortenUrl.alreadyShortened, existingShortUrl));
        }

        let shortUrl: ShortUrlData;
        try {
            shortUrl = await createShortUrl({
                originalUrl: url,
                shortenedUrl: generateRandomString(4),
                addedBy: currentUserId
            });
        } catch (error) {
            const racedShortUrl =
                isDuplicateKeyError(error) && get(error, "keyPattern.originalUrl")
                    ? await getShortUrlByUser(url, currentUserId)
                    : null;

            if (!racedShortUrl) {
                throw error;
            }

            return res
                .status(200)
                .json(shortUrlResponse(Responses.ShortenUrl.alreadyShortened, racedShortUrl));
        }

        if (!(await getUserById(currentUserId))) {
            await deleteByShortUrl(shortUrl.shortenedUrl);
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res
            .status(201)
            .json(shortUrlResponse(Responses.ShortenUrl.urlShortenedSuccess, shortUrl));
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const redirectToOriginalUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.params;

        if (typeof shortenedUrl !== "string" || !shortenedUrl) {
            return res.status(400).json({ error: Responses.ShortenUrl.missingShortenedUrl });
        }

        const response = await getOriginalUrlDb(shortenedUrl);

        if (!response) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        return res.status(302).redirect(response.originalUrl);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const getOriginalUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.params;

        if (typeof shortenedUrl !== "string" || !shortenedUrl) {
            return res.status(400).json({ error: Responses.ShortenUrl.missingShortenedUrl });
        }

        const response = await getOriginalUrlWithUser(shortenedUrl);

        if (!response) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        return res.status(200).json({
            originalUrl: response.originalUrl,
            addedBy: response.addedBy,
            addedOn: response.addedOn
        });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const deleteUrl = async (req: express.Request, res: express.Response) => {
    try {
        const { shortenedUrl } = req.body;

        if (typeof shortenedUrl !== "string" || !shortenedUrl) {
            return res.status(400).json({ error: Responses.ShortenUrl.missingShortenedUrl });
        }

        const response = await deleteByShortUrl(shortenedUrl);

        if (!response) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        return res.status(200).json({ message: Responses.ShortenUrl.urlDeletedSuccess });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: Responses.internalServerError });
    }
};
