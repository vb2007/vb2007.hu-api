import multer from "multer";
import path from "path";
import fs from "fs";
import { get } from "lodash";
import dotenv from "dotenv";

import { parsePositiveInteger } from "./index";
import { MAX_SAFE_MEGABYTES } from "../constants/limits";

dotenv.config();

const defaultMaxFileSizeMb: number = 100;

export const maxFileSizeBytes: number =
    parsePositiveInteger(
        process.env.UPLOAD_MAX_FILESIZE,
        defaultMaxFileSizeMb,
        MAX_SAFE_MEGABYTES
    ) *
    1024 *
    1024;

const storage: multer.StorageEngine = multer.diskStorage({
    destination: (req, file, cb) => {
        const baseUploadDir: string = path.resolve(process.env.UPLOAD_DISK_DIRECTORY);
        const currentUserId: string = get(req, "identity._id").toString();

        const userUploadDir: string = path.join(baseUploadDir, currentUserId);

        fs.mkdirSync(userUploadDir, { recursive: true });

        cb(null, userUploadDir);
    },

    filename: (req, file, cb): void => {
        const fileExt: string = path.extname(file.originalname).toLowerCase();
        cb(null, `${req.uploadId}${fileExt}`);
    }
});

export const upload: multer.Multer = multer({
    storage: storage,
    defParamCharset: "utf8",
    limits: {
        fileSize: maxFileSizeBytes
    }
});
