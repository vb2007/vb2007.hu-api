import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { get } from "lodash";
import dotenv from "dotenv";

import { getUploadById, deleteUploadById, UserUploadsModel } from "../database/userUploads";

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, process.env.UPLOAD_PATH);

        //creates upload directory if it doesn't exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        cb(null, uploadDir)
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + " - " + Math.round(Math.random() * 1E9);
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

                const uploadRecord = new UserUploadsModel({
                    originalFileName: req.file.originalname,
                    uploadedBy: userId,
                    storedFileName: req.file.filename,
                    filePath: req.file.path,
                    fileSize: req.file.size,
                    mimeType: req.file.mimetype
                });

                await uploadRecord.save();

                return res.status(201).json({
                    success: true,
                    upload: {
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

        deleteUploadById(id);
        fs.unlink(upload.filePath, (err) => {
            if (err) {
                console.error("Failed to delete file: ", err);
                return res.status(500).json({ error: "Failed to delete file" });
            }
        });
        
        return res.status(200).json({ success: true, message: "Upload deleted successfully" });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}