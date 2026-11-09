import multer from "multer";
import fs from "fs";
import { get } from "lodash";
import express from "express";
import dotenv from "dotenv";

import { parsePositiveInteger } from "./index";
import { answerTooLarge } from "./requestBody";
import { discardUpload, userUploadDir } from "./userUploads";
import { partialUploadFileName, trackUploadInFlight } from "./partialUploads";
import { MAX_SAFE_MEGABYTES } from "../constants/limits";
import { Responses } from "../constants/responses";

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

const maxFileSizeMb: number = maxFileSizeBytes / 1024 / 1024;

export const fileTooLargeError: string = Responses.UserUploads.fileTooLarge(maxFileSizeMb);

export const uploadTooLargeError: string = Responses.UserUploads.uploadTooLarge(maxFileSizeMb);

const diskStorage: multer.StorageEngine = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir: string = userUploadDir(get(req, "identity._id"));

        fs.mkdirSync(uploadDir, { recursive: true });

        cb(null, uploadDir);
    },

    filename: (req, file, cb): void => {
        cb(null, partialUploadFileName(req.uploadId));
    }
});

const tooLargeUploads: WeakSet<express.Request> = new WeakSet();

const storage: multer.StorageEngine = {
    _handleFile: (req, file, cb): void => {
        trackUploadInFlight(req);
        file.stream.once("limit", (): void => {
            tooLargeUploads.add(req);
            // busboy only ends a truncated file at its closing boundary, so multer would read the whole body first
            file.stream.push(null);
        });
        diskStorage._handleFile(req, file, cb);
    },

    _removeFile: (req, file, cb): void => {
        diskStorage._removeFile(req, file, (error: Error | null): void => {
            if (!tooLargeUploads.has(req)) {
                cb(error);
                return;
            }

            discardUpload(get(req, "identity._id"))
                .then((): void => answerTooLarge(req.res, fileTooLargeError))
                .catch((answerError: unknown): void => console.error(answerError))
                .finally((): void => cb(error));
        });
    }
};

export const upload: multer.Multer = multer({
    storage: storage,
    defParamCharset: "utf8",
    limits: {
        fileSize: maxFileSizeBytes
    }
});
