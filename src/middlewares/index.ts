import express from "express";
import http from "http";
import net from "net";
import bodyParser from "body-parser";
import multer from "multer";
import fs from "fs";
import path from "path";
import { get, merge, pick } from "lodash";

import { getUserBySessionToken } from "../database/users";
import { ApiKey, getUserByApiKey, recordApiKeyUse } from "../database/apiKeys";
import { getOriginalUrl } from "../database/shortUrls";
import { getUploadById } from "../database/userUploads";
import { findPasteById } from "../database/pastebin";
import { Responses } from "../constants/responses";
import { isSuperuserEmail } from "../helpers";
import { answerAndClose, answerTooLarge, isClosingAfterEarlyAnswer } from "../helpers/requestBody";
import { newObjectId, validateObjectId } from "../helpers/prisma";
import { trackPendingWork } from "../helpers/pendingWork";
import { untrackUploadInFlight, untrackUploadInFlightOnClose } from "../helpers/partialUploads";
import { sessionCookie } from "../helpers/session";
import {
    answerRejectedApiKey,
    answerScopeMissing,
    bearerTokenOf,
    hasOneAuthorization,
    hashApiKey,
    isLiveApiKey
} from "../helpers/apiKeys";
import { answerRejectedClient, clientOf } from "../helpers/oauthClients";
import { limitApiKeyChecks } from "./rateLimit";
import {
    upload,
    maxUploadBytes,
    fileTooLargeError,
    uploadTooLargeError,
    isMalformedMultipartError
} from "../helpers/multer";
import { detectUploadType } from "../helpers/fileType";
import { findUploadLimitRejection } from "../helpers/uploadQuota";
import {
    API_KEY_LAST_USE_INTERVAL_MS,
    JSON_BODY_MAX_BYTES,
    PIPELINED_REQUESTS_MAX
} from "../constants/limits";
import {
    discardUpload,
    removeTempFile,
    removeUserUploadDir,
    userStillExists
} from "../helpers/userUploads";

const authenticateSession = async (
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

        merge(req, { identity: pick(existingUser, ["_id", "username", "email"]) });

        return next();
    } catch (error) {
        return next(error);
    }
};

export const refuseApiKeys = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    if (req.headers.authorization !== undefined) {
        return res.status(403).json({ error: Responses.ApiKeys.apiKeyNotAccepted });
    }

    return next();
};

export const isAuthenticated = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => refuseApiKeys(req, res, () => authenticateSession(req, res, next));

const recordUse = (userId: string, { hash, lastUsedAt }: ApiKey, now: Date): void => {
    const usedSince: Date = new Date(now.getTime() - API_KEY_LAST_USE_INTERVAL_MS);

    if (lastUsedAt && lastUsedAt >= usedSince) {
        return;
    }

    trackPendingWork(
        recordApiKeyUse(userId, hash, now, usedSince).catch((error: unknown): void =>
            console.error("API key last use not stored:", error)
        )
    );
};

const liveApiKeyOf = async (token: string, now: Date) => {
    const hash: string = hashApiKey(token);
    const user = await getUserByApiKey(hash);
    const apiKey = user?.authentication.apiKeys?.find(
        (candidate: ApiKey): boolean => candidate.hash === hash
    );

    return apiKey && isLiveApiKey(apiKey, now) ? { user, apiKey } : null;
};

export const isStillAuthenticatedWith = async (
    req: express.Request,
    scope: string
): Promise<boolean> => {
    const userId: string = String(get(req, "identity._id"));
    const authorization: string | undefined = req.headers.authorization;

    if (authorization === undefined) {
        return (await getUserBySessionToken(req.cookies[sessionCookie]))?._id === userId;
    }

    const live = await liveApiKeyOf(bearerTokenOf(authorization), new Date());

    return live?.user._id === userId && live.apiKey.scopes.includes(scope);
};

const authenticateApiKey =
    (scope: string) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const authorization: string | undefined = req.headers.authorization;

            if (authorization === undefined) {
                return authenticateSession(req, res, next);
            }

            const token: string | null = hasOneAuthorization(req)
                ? bearerTokenOf(authorization)
                : null;

            if (!token) {
                return answerRejectedApiKey(res);
            }

            const now: Date = new Date();
            const { user, apiKey } = (await liveApiKeyOf(token, now)) ?? {};

            if (!apiKey) {
                return answerRejectedApiKey(res);
            }

            recordUse(user._id, apiKey, now);

            if (!apiKey.scopes.includes(scope)) {
                return answerScopeMissing(res, scope);
            }

            merge(req, {
                identity: {
                    ...pick(user, ["_id", "username", "email"]),
                    apiKeyId: apiKey.id,
                    scopes: apiKey.scopes
                }
            });

            return next();
        } catch (error) {
            return next(error);
        }
    };

export const isAuthenticatedWith = (scope: string): express.RequestHandler[] => [
    limitApiKeyChecks,
    authenticateApiKey(scope)
];

export const authenticateClient = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const client = clientOf(req);

    if (!client) {
        return answerRejectedClient(res);
    }

    req.oauthClient = client;

    return next();
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

export const noStore = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    res.set("Cache-Control", "no-store");

    return next();
};

const isSuperuserRequest = ({ identity }: express.Request): boolean =>
    isSuperuserEmail(identity.email) &&
    (identity.apiKeyId === undefined || identity.scopes.includes("admin:write"));

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

        if (!isOwner && !isSuperuserRequest(req)) {
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

        if (!validateObjectId(id, res)) {
            return;
        }

        const upload = await getUploadById(id);

        if (!upload) {
            return res.status(404).json({ error: Responses.UserUploads.uploadNotFound });
        }

        const isOwner: boolean = upload.uploadedBy.toString() === currentUserId.toString();

        if (!isOwner && !isSuperuserRequest(req)) {
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

        if (!validateObjectId(id, res)) {
            return;
        }

        const paste = await findPasteById(id);

        if (!paste) {
            return res.status(404).json({ error: Responses.Pastebin.pasteNotFound });
        }

        const isOwner: boolean = paste.addedBy.toString() === currentUserId.toString();

        if (!isOwner && !isSuperuserRequest(req)) {
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

const waitingRequests: WeakMap<net.Socket, number> = new WeakMap();

const overflowedSockets: WeakSet<net.Socket> = new WeakSet();

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

    if (overflowedSockets.has(socket)) {
        // Node only stops reading a connection once the answers queued on it fill its buffer, which requests that write nothing never do
        req.resume();
        res.setHeader("Connection", "close");
        res.status(429).json({ error: Responses.tooManyPipelinedRequests });
        return;
    }

    const waiting: number = waitingRequests.get(socket) ?? 0;
    const overflows: boolean = waiting >= PIPELINED_REQUESTS_MAX;

    if (overflows) {
        overflowedSockets.add(socket);
    }

    waitingRequests.set(socket, waiting + 1);

    const start = (): Promise<void> => {
        waitingRequests.set(socket, waitingRequests.get(socket) - 1);

        if (isClosingAfterEarlyAnswer(socket) || socket.destroyed) {
            req.resume();
            return;
        }

        const done: Promise<void> = responseDone(res);

        if (overflows) {
            answerAndClose(res, 429, Responses.tooManyPipelinedRequests);
        } else {
            next();
        }

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

    req.uploadId = newObjectId();

    const abortOnSocketClose = (): void => {
        req.destroy();
    };

    // An answered request is no longer watched by Node, so multer never learns that its client left
    req.socket.once("close", abortOnSocketClose);

    upload.single("file")(req, res, async (error) => {
        req.socket.off("close", abortOnSocketClose);

        if (res.headersSent) {
            if (
                error &&
                !(error instanceof multer.MulterError) &&
                !isMalformedMultipartError(error)
            ) {
                console.error(error);
            }

            return trackPendingWork(
                discardUpload(get(req, "identity._id"), req.file?.path).finally((): void =>
                    untrackUploadInFlight(req)
                )
            );
        }

        if (!error) {
            untrackUploadInFlightOnClose(req);
            return next();
        }

        await discardUpload(get(req, "identity._id"));
        untrackUploadInFlight(req);

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
        const uploadType = await detectUploadType(req.file.path, req.file.originalname.trim());

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

        const rejection = await findUploadLimitRejection(userId, req.file.size, 1);

        if (rejection) {
            await discardUpload(userId, req.file.path);
            return res.status(rejection.status).json({ error: rejection.error });
        }

        return next();
    } catch (error) {
        await discardUpload(get(req, "identity._id"), req.file.path);
        return next(error);
    }
};
