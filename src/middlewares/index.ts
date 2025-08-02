import express from "express";
import { get, merge } from "lodash";

import { getUserBySessionToken, verifySuperUserById } from "../database/users";
import { checkIfShortUrlIsOwnedByUser } from "../database/shortUrls";
import { Responses } from "../constants/responses";

export const isAuthenticated = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const sessionToken = req.cookies["VB-AUTH"];
        if (!sessionToken) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const existingUser = await getUserBySessionToken(sessionToken);
        if (!existingUser) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        merge(req, { identity: existingUser });

        return next();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const isOwner = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;
        const currentUserId = get(req, "identity._id") as string;

        if (!currentUserId) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (currentUserId.toString() !== id) {
            return res.status(403).json({ error: Responses.notAuthorized });
        }

        return next();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const isSuperUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const currentUserId = get(req, "identity._id") as string;
        const isSuperUser = await verifySuperUserById(currentUserId.toString());

        if (!isSuperUser) {
            return res.status(403).json({ error: Responses.notAuthorized });
        }

        return next();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const isShortUrlOwner = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { shortenedUrl } = req.params;
        const currentUserId = get(req, "identity._id") as string;

        if (!currentUserId) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const isOwner = await checkIfShortUrlIsOwnedByUser(shortenedUrl, currentUserId);

        if (!isOwner) {
            return res.status(403).json({ error: Responses.ShortenUrl.notAuthorizedToDelete });
        }

        return next();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
