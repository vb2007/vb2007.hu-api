import express from "express";
import fs from "fs";
import { get, omit } from "lodash";

import {
    UserUploadsModel,
    deleteUploadById,
    createUserUpload,
    getUploadsByUsername,
    countUploadsByUser
} from "../database/userUploads";
import { getUserByUsername } from "../database/users";
import { Responses } from "../constants/responses";

export const getUploadDetails = async (req: express.Request, res: express.Response) => {
    try {
        const userUpload = get(req, "upload") as InstanceType<typeof UserUploadsModel>;

        return res
            .status(200)
            .json({ upload: omit(userUpload.toObject(), ["filePath", "storedFileName"]) });
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

        const userId: string = get(req, "identity._id");
        const username: string = get(req, "identity.username", "anonymous");

        const uploadRecord = await createUserUpload({
            originalFileName: req.file.originalname,
            uploadedBy: userId,
            storedFileName: req.file.filename,
            filePath: req.file.path,
            fileSize: req.file.size,
            mimeType: req.file.mimetype
        });

        const cdnPath = `${process.env.CDN_URL}/uploads/${username}/${uploadRecord.storedFileName}`;

        return res.status(201).json({
            success: true,
            upload: {
                directUrl: cdnPath,
                id: uploadRecord._id,
                originalFileName: uploadRecord.originalFileName,
                uploadedOn: uploadRecord.uploadedOn
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to process upload" });
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

export const findUploadsByUsername = async (req: express.Request, res: express.Response) => {
    try {
        const { username } = req.params;
        const limit: number = req.query.limit ? parseInt(req.query.limit as string) : 10;
        const page: number = req.query.page ? parseInt(req.query.page as string) : 1;
        const sortBy: string = (req.query.sortBy as string) || "addedOn";
        const sortOrder: string = (req.query.sortOrder as string) || "desc";

        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const uploads = await getUploadsByUsername(
            user._id,
            limit,
            page,
            sortBy,
            sortOrder as "asc" | "desc"
        );

        const total: number = await countUploadsByUser(user._id);

        return res.status(200).json({
            uploads,
            pagination: {
                limit,
                page,
                total,
                pages: Math.ceil(total / limit),
                sortBy,
                sortOrder
            }
        });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
