import express from "express";
import fs from "fs";
import { get } from "lodash";

import {
    UserUploadsModel,
    deleteUploadById,
    updateUploadById,
    createUserUpload,
    findUploadsByUser,
    getUploadAccessById,
    UploadVisibility
} from "../database/userUploads";
import { getUserBySessionToken } from "../database/users";
import { Responses } from "../constants/responses";
import { ALLOWED_UPLOAD_TYPES } from "../constants/uploads";
import {
    findInvalidUploadListParam,
    isUploadFileName,
    isUploadVisibility,
    toRfc5987FileName,
    toUploadListOptions,
    toUploadResponse
} from "../helpers/userUploads";
import { calculateUploadUsage, getUploadQuotaBytes } from "../helpers/uploadQuota";
import { maxFileSizeBytes } from "../helpers/multer";

const uploadPathRegex: RegExp = /^\/useruploads\/([0-9a-f]{24})\/([0-9a-f]{24})(\.[a-z0-9]+)$/;

const isSessionOf = async (sessionToken: string, userId: string): Promise<boolean> => {
    if (!sessionToken) {
        return false;
    }

    const user = await getUserBySessionToken(sessionToken);

    return user?._id.toString() === userId;
};

export const checkUploadAccess = async (req: express.Request, res: express.Response) => {
    try {
        const originalUri: string = req.get("X-Original-URI") ?? "";
        const match: RegExpMatchArray | null = originalUri.split("?")[0].match(uploadPathRegex);

        if (!match) {
            return res.sendStatus(403);
        }

        const [, userId, uploadId, extension] = match;
        const upload = await getUploadAccessById(uploadId);

        if (!upload || upload.uploadedBy.toString() !== userId || upload.extension !== extension) {
            return res.sendStatus(403);
        }

        const visibility: string = upload.visibility ?? "private";

        if (visibility !== "public" && !(await isSessionOf(req.cookies["VB-AUTH"], userId))) {
            return res.sendStatus(403);
        }

        res.set({
            "X-Upload-Visibility": visibility,
            "X-Upload-Filename": toRfc5987FileName(upload.originalFileName)
        });

        return res.sendStatus(204);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const getUploadDetails = async (req: express.Request, res: express.Response) => {
    try {
        const userUpload = get(req, "upload") as InstanceType<typeof UserUploadsModel>;

        return res.status(200).json({ upload: toUploadResponse(userUpload) });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const getUploadUsage = async (req: express.Request, res: express.Response) => {
    try {
        const userId: string = get(req, "identity._id");
        const [quotaBytes, { usedBytes, count, byCategory }] = await Promise.all([
            getUploadQuotaBytes(userId),
            calculateUploadUsage(userId)
        ]);

        return res.status(200).json({
            usedBytes,
            quotaBytes,
            count,
            maxFileSizeBytes,
            allowedTypes: ALLOWED_UPLOAD_TYPES,
            byCategory
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const uploadFile = async (req: express.Request, res: express.Response) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: Responses.UserUploads.noFileProvided });
        }

        const visibility: unknown = req.body.visibility ?? "private";

        if (!isUploadVisibility(visibility)) {
            await fs.promises.unlink(req.file.path);
            return res.status(400).json({ error: Responses.UserUploads.invalidVisibility });
        }

        const userId: string = get(req, "identity._id");

        const uploadRecord = await createUserUpload({
            _id: req.uploadId,
            originalFileName: req.file.originalname,
            uploadedBy: userId,
            storedFileName: req.file.filename,
            filePath: req.file.path,
            extension: req.uploadType.extension,
            fileSize: req.file.size,
            mimeType: req.uploadType.mimeType,
            visibility
        });

        return res.status(201).json({
            message: Responses.UserUploads.uploadSuccess,
            upload: toUploadResponse(uploadRecord)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to process upload" });
    }
};

export const updateUpload = async (req: express.Request, res: express.Response) => {
    try {
        const userUpload = get(req, "upload") as InstanceType<typeof UserUploadsModel>;
        const { originalFileName, visibility } = req.body ?? {};

        if (originalFileName === undefined && visibility === undefined) {
            return res.status(400).json({ error: Responses.UserUploads.nothingToUpdate });
        }

        const values: {
            originalFileName?: string;
            visibility?: UploadVisibility;
            updatedOn: Date;
        } = { updatedOn: new Date() };

        if (originalFileName !== undefined) {
            const fileName: unknown =
                typeof originalFileName === "string" ? originalFileName.trim() : originalFileName;

            if (!isUploadFileName(fileName)) {
                return res.status(400).json({ error: Responses.UserUploads.invalidFileName });
            }

            values.originalFileName = fileName;
        }

        if (visibility !== undefined) {
            if (!isUploadVisibility(visibility)) {
                return res.status(400).json({ error: Responses.UserUploads.invalidVisibility });
            }

            values.visibility = visibility;
        }

        const updatedUpload = await updateUploadById(userUpload._id.toString(), values);

        return res.status(200).json({
            message: Responses.UserUploads.uploadUpdatedSuccess,
            upload: toUploadResponse(updatedUpload)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const deleteUpload = async (req: express.Request, res: express.Response) => {
    try {
        const userUpload = get(req, "upload") as InstanceType<typeof UserUploadsModel>;

        try {
            await fs.promises.unlink(userUpload.filePath);
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error("Failed to delete file on disk: ", error);
                return res.status(500).json({ error: error.message });
            }
        }

        await deleteUploadById(userUpload._id.toString());

        return res.status(200).json({
            message: Responses.UserUploads.uploadDeletedSuccess,
            upload: { id: userUpload._id }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const listUploads = async (req: express.Request, res: express.Response) => {
    try {
        const invalidParam: string | undefined = findInvalidUploadListParam(req.query);

        if (invalidParam) {
            return res
                .status(400)
                .json({ error: Responses.UserUploads.invalidQuery(invalidParam) });
        }

        const options = toUploadListOptions(req.query);
        const userId: string = get(req, "identity._id");

        const [uploads, total] = await findUploadsByUser(userId, options);

        return res.status(200).json({
            uploads: uploads.map(toUploadResponse),
            pagination: {
                limit: options.limit,
                page: options.page,
                total,
                pages: Math.ceil(total / options.limit),
                sortBy: options.sortBy,
                sortOrder: options.sortOrder
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};
