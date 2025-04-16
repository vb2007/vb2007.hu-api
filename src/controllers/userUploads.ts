import express from "express";
import multer, { Multer } from "multer";
import path from "path";
import fs from "fs";
import { get } from "lodash";

import { getUploadDetailsById, UserUploadsModel } from "../database/userUploads";

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, "../../uploads");

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
        fileSize: 5 * 1024 * 1024, //5 MB upload limit, this will later be configurable from the .env file
    }
});

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

export const getUploadDetails = async(req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ error: "Upload ID is required" });
        }

        const upload = await getUploadDetailsById(id);

        if (!upload) {
            return res.status(404).json({ error: "Upload not found" });
        }

        return res.status(200).json({ upload });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}