import express from "express";
import { get, merge } from "lodash";

import { getUserBySessionToken } from "../database/users";
import { checkIfShortUrlIsOwnedByUser } from "../database/shortUrls";

export const isAuthenticated = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const sessionToken = req.cookies["VB-AUTH"];

        if (!sessionToken) {
            return res.status(403).json({ error: "You must be logged in to perform this action." });
        }

        const existingUser = await getUserBySessionToken(sessionToken);

        if (!existingUser) {
            return res.status(403).json({ error: "You must be logged in to perform this action." });
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
            return res.status(403).json({ error: "You must be logged in to perform this action." });
        }

        if (currentUserId.toString() !== id) {
            return res
                .status(403)
                .json({ error: "You do not have permission to perform this action." });
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
            return res.status(403).json({ error: "You must be logged in to perform this action." });
        }

        const isOwner = await checkIfShortUrlIsOwnedByUser(shortenedUrl, currentUserId);

        if (!isOwner) {
            return res
                .status(403)
                .json({ error: "You can only delete URLs created with your account." });
        }

        return next();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
