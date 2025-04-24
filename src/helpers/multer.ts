import multer from "multer";
import express from "express";
import path from "path";
import fs from "fs";
import { get } from "lodash";
import dotenv from "dotenv";

dotenv.config();

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

export const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: parseInt(process.env.UPLOAD_MAX_FILESIZE) * 1024 * 1024,
    }
});