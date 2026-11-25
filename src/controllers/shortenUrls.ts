import express from "express";
import { get } from "lodash";

import {
    getOriginalUrl as getOriginalUrlDb,
    getOriginalUrlWithUser,
    getShortUrlByUser,
    countShortUrlsByUser,
    createShortUrl,
    deleteByShortUrl,
    findShortUrlsByUser
} from "../database/shortUrls";
import { User, getUserById } from "../database/users";
import { generateRandomString, validateUri } from "../helpers/text";
import { isDuplicateKeyOn } from "../helpers/prisma";
import { withLock } from "../helpers/lock";
import {
    findInvalidShortUrlListParam,
    toShortUrlListOptions,
    toShortUrlOwner,
    toShortUrlPagination
} from "../helpers/shortUrls";
import { Responses } from "../constants/responses";
import {
    SHORT_URL_CODE_ATTEMPTS,
    SHORT_URL_CODE_LENGTH,
    SHORT_URL_MAX_LENGTH,
    SHORT_URLS_PER_USER_MAX
} from "../constants/limits";

type ShortUrlData = {
    shortenedUrl: string;
    originalUrl: string;
    addedOn: Date | null;
    addedBy: unknown;
};

const shortUrlResponse = (
    message: string,
    { shortenedUrl, originalUrl, addedOn }: ShortUrlData,
    owner: User | null
): Object => ({
    message,
    data: {
        shortenedUrl,
        originalUrl,
        addedOn,
        addedBy: toShortUrlOwner(
            owner && { id: owner._id, username: owner.username, createdAt: owner.createdAt }
        )
    }
});

const alreadyShortened = async (shortUrl: ShortUrlData): Promise<Object> =>
    shortUrlResponse(
        Responses.ShortenUrl.alreadyShortened,
        shortUrl,
        await getUserById(String(shortUrl.addedBy))
    );

const createWithFreshCode = async (
    originalUrl: string,
    addedBy: string,
    attempt: number = 1
): Promise<ShortUrlData> => {
    try {
        return await createShortUrl({
            originalUrl,
            shortenedUrl: generateRandomString(SHORT_URL_CODE_LENGTH),
            addedBy
        });
    } catch (error) {
        if (attempt < SHORT_URL_CODE_ATTEMPTS && isDuplicateKeyOn(error, "shortenedUrl")) {
            return createWithFreshCode(originalUrl, addedBy, attempt + 1);
        }
        throw error;
    }
};

export const shortenUrl = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { url } = req.body;
        const currentUserId = get(req, "identity._id") as string;

        if (typeof url !== "string" || !validateUri(url)) {
            return res.status(400).json({ error: Responses.ShortenUrl.invalidUrl });
        }

        if (url.length > SHORT_URL_MAX_LENGTH) {
            return res.status(400).json({ error: Responses.ShortenUrl.urlTooLong });
        }

        return await withLock(`shortUrls:${currentUserId}`, async () => {
            const existingShortUrl = await getShortUrlByUser(url, currentUserId);
            if (existingShortUrl) {
                return res.status(200).json(await alreadyShortened(existingShortUrl));
            }

            if ((await countShortUrlsByUser(currentUserId)) >= SHORT_URLS_PER_USER_MAX) {
                return res.status(409).json({ error: Responses.ShortenUrl.tooManyShortUrls });
            }

            let shortUrl: ShortUrlData;
            try {
                shortUrl = await createWithFreshCode(url, currentUserId);
            } catch (error) {
                const racedShortUrl = isDuplicateKeyOn(error, "originalUrl")
                    ? await getShortUrlByUser(url, currentUserId)
                    : null;

                if (!racedShortUrl) {
                    throw error;
                }

                return res.status(200).json(await alreadyShortened(racedShortUrl));
            }

            const owner = await getUserById(currentUserId);
            if (!owner) {
                await deleteByShortUrl(shortUrl.shortenedUrl);
                return res.status(403).json({ error: Responses.notLoggedIn });
            }

            return res
                .status(201)
                .json(shortUrlResponse(Responses.ShortenUrl.urlShortenedSuccess, shortUrl, owner));
        });
    } catch (error) {
        return next(error);
    }
};

export const redirectToOriginalUrl = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { shortenedUrl } = req.params;

        const response = await getOriginalUrlDb(shortenedUrl);

        if (!response) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        return res.status(302).redirect(response.originalUrl);
    } catch (error) {
        return next(error);
    }
};

export const getOriginalUrl = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { shortenedUrl } = req.params;

        const response = await getOriginalUrlWithUser(shortenedUrl);

        if (!response) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        return res.status(200).json({
            originalUrl: response.originalUrl,
            addedBy: toShortUrlOwner(response.owner),
            addedOn: response.addedOn
        });
    } catch (error) {
        return next(error);
    }
};

export const listShortUrls = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const invalidParam: string | undefined = findInvalidShortUrlListParam(req.query);

        if (invalidParam) {
            return res.status(400).json({ error: Responses.invalidQuery(invalidParam) });
        }

        const options = toShortUrlListOptions(req.query);
        const userId: string = get(req, "identity._id");

        const [shortUrls, total] = await findShortUrlsByUser(userId, options);

        return res.status(200).json({
            shortUrls,
            pagination: toShortUrlPagination(options, total)
        });
    } catch (error) {
        return next(error);
    }
};

export const deleteUrl = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { shortenedUrl } = req.params;

        const response = await deleteByShortUrl(shortenedUrl);

        if (!response) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        return res.status(200).json({ message: Responses.ShortenUrl.urlDeletedSuccess });
    } catch (error) {
        return next(error);
    }
};
