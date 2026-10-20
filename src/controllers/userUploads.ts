import express from "express";
import fs from "fs";
import { get } from "lodash";

import {
    UserUploadsModel,
    deleteUploadById,
    updateUploadById,
    createUserUpload,
    findUploadsByUser,
    UploadVisibility
} from "../database/userUploads";
import { Responses } from "../constants/responses";
import {
    findInvalidUploadListParam,
    isUploadFileName,
    isUploadVisibility,
    toUploadListOptions,
    toUploadResponse
} from "../helpers/userUploads";

export const getUploadDetails = async (req: express.Request, res: express.Response) => {
    try {
        const userUpload = get(req, "upload") as InstanceType<typeof UserUploadsModel>;

        return res.status(200).json({ upload: toUploadResponse(userUpload) });
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
