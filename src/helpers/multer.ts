import multer from "multer";
import path from "path";
import fs from "fs";
import { get } from "lodash";
import dotenv from "dotenv";

dotenv.config();

const defaultMaxFileSizeMb: number = 100;

const parseMaxFileSizeMb = (value: string | undefined): number => {
    const sizeMb: number = Number(value);
    return Number.isInteger(sizeMb) && sizeMb > 0 ? sizeMb : defaultMaxFileSizeMb;
};

export const maxFileSizeBytes: number =
    parseMaxFileSizeMb(process.env.UPLOAD_MAX_FILESIZE) * 1024 * 1024;

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
