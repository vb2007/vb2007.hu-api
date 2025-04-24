import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { get } from "lodash";

import { getUploadById, deleteUploadById, UserUploadsModel } from "../database/userUploads";
import { upload } from "../helpers/multer";

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const baseUploadDir = path.join(__dirname, process.env.UPLOAD_DISK_DIRECTORY);
        const currentUsername: string = get(req, 'identity.username') as string;

        const userUploadDir = path.join(baseUploadDir, currentUsername);

        //creates base upload directory if it doesn't exists
        if (!fs.existsSync(baseUploadDir)) {
            fs.mkdirSync(baseUploadDir, { recursive: true });
        }

        //creates user-specific upload directory if it doesn't exists
        if (!fs.existsSync(userUploadDir)) {
            fs.mkdirSync(userUploadDir, { recursive: true });
        }

        cb(null, userUploadDir)
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
        const fileExt = path.extname(file.originalname);
        cb(null, uniqueSuffix + fileExt);
    }
});

//accepts all files for now, this will later be used for filtering
const fileFilter = (req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    cb(null, true)
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: parseInt(process.env.UPLOAD_MAX_FILESIZE) * 1024 * 1024,
    }
});

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
                console.error("Unknown error: ", error);
                return res.status(500).json({ error: error.message });
            }

            try {
                if (!req.file) {
                    return res.status(400).json({ error: "No file provided" });
                }

                const userId = get(req, "identity._id");
                const username = get(req, "identity.username", "anonymous");

                const uploadRecord = new UserUploadsModel({
                    originalFileName: req.file.originalname,
                    uploadedBy: userId,
                    storedFileName: req.file.filename,
                    filePath: req.file.path,
                    fileSize: req.file.size,
                    mimeType: req.file.mimetype
                });

                await uploadRecord.save();

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
        
        return res.status(200).json({ success: true, message: "Upload deleted successfully" });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}