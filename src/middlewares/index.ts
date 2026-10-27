import express from "express";
import http from "http";
import multer from "multer";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { get, merge } from "lodash";

import { getUserBySessionToken } from "../database/users";
import { getOriginalUrl } from "../database/shortUrls";
import { getUploadById } from "../database/userUploads";
import { findPasteById } from "../database/pastebin";
import { Responses } from "../constants/responses";
import { isSuperuserEmail } from "../helpers";
import { validateMongooseId } from "../helpers/mongoose";
import { upload, maxFileSizeBytes } from "../helpers/multer";
import { detectUploadType } from "../helpers/fileType";
import { exceedsUploadQuota } from "../helpers/uploadQuota";
import { removeTempFile, userStillExists } from "../helpers/userUploads";

export const isAuthenticated = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const sessionToken: any = req.cookies["VB-AUTH"];

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

export const isSuperuser = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const email = get(req, "identity.email") as string;

    if (!isSuperuserEmail(email)) {
        return res.status(403).json({ error: Responses.notAuthorized });
    }

    return next();
};

export const isShortUrlOwner = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { shortenedUrl } = req.body;
        const currentUserId = get(req, "identity._id") as string;

        if (!currentUserId) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (typeof shortenedUrl !== "string" || !shortenedUrl) {
            return res.status(400).json({ error: Responses.ShortenUrl.missingShortenedUrl });
        }

        const shortUrl = await getOriginalUrl(shortenedUrl);

        if (!shortUrl) {
            return res.status(404).json({ error: Responses.ShortenUrl.urlNotFound });
        }

        const isOwner: boolean = shortUrl.addedBy.toString() === currentUserId.toString();

        if (!isOwner && !isSuperuserEmail(get(req, "identity.email") as string)) {
            return res.status(403).json({ error: Responses.ShortenUrl.notAuthorizedToDelete });
        }

        return next();
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const isUploadOwner = async (
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

        if (!validateMongooseId(id, res)) {
            return;
        }

        const upload = await getUploadById(id);

        if (!upload) {
            return res.status(404).json({ error: Responses.UserUploads.uploadNotFound });
        }

        const isOwner: boolean = upload.uploadedBy.toString() === currentUserId.toString();
        const email = get(req, "identity.email") as string;

        if (!isOwner && !isSuperuserEmail(email)) {
            return res.status(403).json({ error: Responses.notAuthorized });
        }

        merge(req, { upload });

        return next();
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const isPasteOwner = async (
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

        if (!validateMongooseId(id, res)) {
            return;
        }

        const paste = await findPasteById(id);

        if (!paste) {
            return res.status(404).json({ error: Responses.Pastebin.pasteNotFound });
        }

        const isOwner: boolean = paste.addedBy.toString() === currentUserId.toString();

        if (!isOwner && !isSuperuserEmail(get(req, "identity.email") as string)) {
            return res.status(403).json({ error: Responses.notAuthorized });
        }

        merge(req, { paste });

        return next();
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const handleUpload = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    req.uploadId = new mongoose.Types.ObjectId();

    upload.single("file")(req, res, (error) => {
        if (!error) {
            return next();
        }

        if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                const maxMb: number = maxFileSizeBytes / 1024 / 1024;
                return res.status(413).json({ error: Responses.UserUploads.fileTooLarge(maxMb) });
            }

            return res.status(400).json({ error: error.message });
        }

        console.error(error);
        return res.status(500).json({ error: error.message });
    });
};

type RequestError = Error & { type?: string; status?: number; expose?: boolean };

export const handleRequestError = (
    error: RequestError,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ error: Responses.invalidJson });
    }

    const status: number = error.status >= 400 ? error.status : 500;

    if (status >= 500) {
        console.error(error);
    }

    return res
        .status(status)
        .json({ error: error.expose ? error.message : http.STATUS_CODES[status] });
};

export const verifyUploadType = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (!req.file) {
        return next();
    }

    try {
        const uploadType = await detectUploadType(req.file.path, req.file.originalname);

        if (!uploadType) {
            await removeTempFile(req.file.path);
            return res.status(415).json({ error: Responses.UserUploads.unsupportedFileType });
        }

        const storedFileName: string = `${req.uploadId}${uploadType.extension}`;

        if (req.file.filename !== storedFileName) {
            const storedFilePath: string = path.join(req.file.destination, storedFileName);
            await fs.promises.rename(req.file.path, storedFilePath);
            req.file.filename = storedFileName;
            req.file.path = storedFilePath;
        }

        req.uploadType = uploadType;

        return next();
    } catch (error) {
        console.error(error);
        await removeTempFile(req.file.path);

        if (!(await userStillExists(get(req, "identity._id")))) {
            await fs.promises
                .rm(req.file.destination, { recursive: true, force: true })
                .catch((): void => undefined);
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res.status(500).json({ error: "Failed to process upload" });
    }
};

export const checkUploadQuota = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (!req.file) {
        return next();
    }

    try {
        const userId: string = get(req, "identity._id");

        if (await exceedsUploadQuota(userId, req.file.size)) {
            await removeTempFile(req.file.path);
            return res.status(413).json({ error: Responses.UserUploads.quotaExceeded });
        }

        return next();
    } catch (error) {
        console.error(error);
        await removeTempFile(req.file.path);
        return res.status(500).json({ error: error.message });
    }
};
