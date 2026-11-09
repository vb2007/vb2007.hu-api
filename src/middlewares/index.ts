import express from "express";
import http from "http";
import net from "net";
import bodyParser from "body-parser";
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
import { answerTooLarge, isClosingAfterEarlyAnswer } from "../helpers/requestBody";
import { validateMongooseId } from "../helpers/mongoose";
import { trackPendingWork } from "../helpers/pendingWork";
import { sessionCookie } from "../helpers/session";
import {
    upload,
    maxUploadBytes,
    fileTooLargeError,
    uploadTooLargeError,
    isMalformedMultipartError
} from "../helpers/multer";
import { detectUploadType } from "../helpers/fileType";
import { exceedsUploadQuota } from "../helpers/uploadQuota";
import { JSON_BODY_MAX_BYTES } from "../constants/limits";
import {
    discardUpload,
    removeTempFile,
    removeUserUploadDir,
    userStillExists
} from "../helpers/userUploads";

export const isAuthenticated = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const sessionToken: any = req.cookies[sessionCookie];

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
        return next(error);
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

        if (currentUserId.toString() !== id.toLowerCase()) {
            return res.status(403).json({ error: Responses.notAuthorized });
        }

        return next();
    } catch (error) {
        return next(error);
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
        const { shortenedUrl } = req.params;
        const currentUserId = get(req, "identity._id") as string;

        if (!currentUserId) {
            return res.status(403).json({ error: Responses.notLoggedIn });
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
        return next(error);
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
        return next(error);
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
        return next(error);
    }
};

const isOverContentLength = (req: express.Request, limitBytes: number): boolean =>
    Number(req.get("Content-Length")) > limitBytes;

const previousResponses: WeakMap<net.Socket, Promise<void>> = new WeakMap();

const responseDone = (res: express.Response): Promise<void> =>
    new Promise((resolve): void => {
        res.once("finish", resolve);
        res.once("close", resolve);
    });

export const ignoreRequestsAfterEarlyAnswer = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const socket: net.Socket = req.socket;

    const start = (): Promise<void> => {
        if (isClosingAfterEarlyAnswer(socket) || socket.destroyed) {
            req.resume();
            return;
        }

        const done: Promise<void> = responseDone(res);
        next();
        return done;
    };

    const previous: Promise<void> | undefined = previousResponses.get(socket);
    previousResponses.set(socket, previous ? previous.then(start) : Promise.resolve(start()));
};

export const ignoreRequestsFromGoneClients = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    // Node keeps a socket's address once read, so req.ip stays set after the client goes.
    if (req.ip === undefined) {
        return;
    }

    return next();
};

const parseJson = bodyParser.json({ limit: JSON_BODY_MAX_BYTES });

export const parseJsonBody = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (!req.is("application/json")) {
        return parseJson(req, res, next);
    }

    if (isOverContentLength(req, JSON_BODY_MAX_BYTES)) {
        return answerTooLarge(res, Responses.requestTooLarge);
    }

    let receivedBytes: number = 0;

    req.on("data", (chunk: Buffer): void => {
        receivedBytes += chunk.length;

        if (receivedBytes > JSON_BODY_MAX_BYTES) {
            answerTooLarge(res, Responses.requestTooLarge);
        }
    });

    return parseJson(req, res, (error?: unknown): void => {
        if (!res.headersSent) {
            next(error);
        }
    });
};

export const handleUpload = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (isOverContentLength(req, maxUploadBytes)) {
        return answerTooLarge(res, uploadTooLargeError);
    }

    req.uploadId = new mongoose.Types.ObjectId();

    upload.single("file")(req, res, async (error) => {
        if (res.headersSent) {
            if (
                error &&
                !(error instanceof multer.MulterError) &&
                !isMalformedMultipartError(error)
            ) {
                console.error(error);
            }

            return trackPendingWork(discardUpload(get(req, "identity._id"), req.file?.path));
        }

        if (!error) {
            return next();
        }

        await discardUpload(get(req, "identity._id"));

        if (res.headersSent) {
            return;
        }

        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            return answerTooLarge(res, fileTooLargeError);
        }

        if (error instanceof multer.MulterError || isMalformedMultipartError(error)) {
            return res.status(400).json({ error: error.message });
        }

        return next(error);
    });
};

type RequestError = Error & { type?: string; status?: number; expose?: boolean };

const isHttpError = (error: RequestError): boolean =>
    typeof error.expose === "boolean" || error instanceof URIError;

export const handleRequestError = (
    error: RequestError,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (res.headersSent) {
        return next(error);
    }

    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ error: Responses.invalidJson });
    }

    const status: number = isHttpError(error) && error.status >= 400 ? error.status : 500;

    if (status >= 500) {
        console.error(error);
        return res.status(status).json({ error: Responses.internalServerError });
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
            await discardUpload(get(req, "identity._id"), req.file.path);
            return res.status(415).json({ error: Responses.UserUploads.unsupportedFileType });
        }

        const storedFileName: string = `${req.uploadId}${uploadType.extension}`;
        const storedFilePath: string = path.join(req.file.destination, storedFileName);

        await fs.promises.rename(req.file.path, storedFilePath);
        req.file.filename = storedFileName;
        req.file.path = storedFilePath;

        req.uploadType = uploadType;

        return next();
    } catch (error) {
        await removeTempFile(req.file.path);

        if (!(await userStillExists(get(req, "identity._id")))) {
            await removeUserUploadDir(get(req, "identity._id"));
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return next(error);
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
            await discardUpload(userId, req.file.path);
            return res.status(413).json({ error: Responses.UserUploads.quotaExceeded });
        }

        return next();
    } catch (error) {
        await discardUpload(get(req, "identity._id"), req.file.path);
        return next(error);
    }
};
