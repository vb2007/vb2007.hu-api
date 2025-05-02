import express from "express";
import multer from "multer";
import fs from "fs";
import { get } from "lodash";

import { getUploadById, deleteUploadById, createUserUpload } from "../database/userUploads";
import { upload } from "../helpers/multer";
import { getUserByUsername } from "../database/users";

export const getUploadDetails = async(req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ error: "Upload ID is required" });
        }

        const upload = await getUploadById(id);

        if (!upload) {
            return res.status(404).json({ error: "Upload not found" });
        }

        return res.status(200).json({ upload });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const uploadFile = async(req: express.Request, res: express.Response) => {
    try {
        const uploadSingle = upload.single('file');

        uploadSingle(req, res, async(error) => {
            if (error instanceof multer.MulterError) {
                console.error("Multer error: ", error)
                return res.status(500).json({ error: error.message });
            }
            else if (error) {
                if (error.message.includes("file type")) {
                    return res.status(400).json({ error: "Invalid file type, only images are allowed" });
                }

                console.error("Unknown error: ", error);
                return res.status(500).json({ error: error.message });
            }

            try {
                if (!req.file) {
                    return res.status(400).json({ error: "No file provided" });
                }

                const userId = get(req, "identity._id");
                const username = get(req, "identity.username", "anonymous");

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
        });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const deleteUpload = async(req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        const upload = await getUploadById(id);

        if (!upload) {
            return res.status(404).json({ error: "Upload not found" });
        }

        await deleteUploadById(id);
        
        try {
            await fs.promises.unlink(upload.filePath);
            return res.status(200).json({ success: true, message: "Upload deleted successfully" });
        } catch (error) {
            console.error("Failed to delete file on disk: ", error);
            return res.status(500).json({ error: "Failed to delete file on disk" });
        }
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const getUploadsByUsername = async(req: express.Request, res: express.Response) => {
    try {
        const { username } = req.params;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
        const page = req.query.page ? parseInt(req.query.page as string) : 1;
        const sortBy = (req.query.sortBy as string) || "addedOn";
        const sortOrder = (req.query.sortOrder as string) || "desc";

        const user = await getUserByUsername(username);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}