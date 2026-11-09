import multer from "multer";
import fs from "fs";
import { get } from "lodash";
import express from "express";
import { Readable, Writable } from "stream";
import dotenv from "dotenv";

import { parsePositiveInteger } from "./index";
import { answerAndClose } from "./requestBody";
import { discardUpload, userUploadDir } from "./userUploads";
import { partialUploadFileName, trackUploadInFlight } from "./partialUploads";
import {
    MAX_SAFE_MEGABYTES,
    UPLOAD_MAX_FIELDS,
    UPLOAD_MAX_FILES,
    UPLOAD_MULTIPART_OVERHEAD_BYTES
} from "../constants/limits";
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

export const maxUploadBytes: number = maxFileSizeBytes + UPLOAD_MULTIPART_OVERHEAD_BYTES;

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

interface UploadRejection {
    status: number;
    error: string;
}

interface FieldInfo {
    nameTruncated: boolean;
    valueTruncated: boolean;
}

export const isMalformedMultipartError = (error: NodeJS.ErrnoException): boolean =>
    error.constructor === Error && !error.code;

const rejectedUploads: WeakMap<express.Request, UploadRejection> = new WeakMap();

const storingUploads: WeakSet<express.Request> = new WeakSet();

const answerRejection = (req: express.Request): void => {
    if (req.complete) {
        return;
    }

    const { status, error }: UploadRejection = rejectedUploads.get(req);
    answerAndClose(req.res, status, error);
};

const rejectUpload = (req: express.Request, status: number, error: string): void => {
    if (rejectedUploads.has(req)) {
        return;
    }

    rejectedUploads.set(req, { status, error });

    if (!storingUploads.has(req)) {
        answerRejection(req);
    }
};

// multer 2 also raises MISSING_FIELD_NAME, which @types/multer doesn't list
type PartErrorCode = multer.ErrorCode | "MISSING_FIELD_NAME";

const rejectPart = (req: express.Request, code: PartErrorCode, field?: string): void =>
    rejectUpload(req, 400, new multer.MulterError(code as multer.ErrorCode, field).message);

const storage: multer.StorageEngine = {
    _handleFile: (req, file, cb): void => {
        storingUploads.add(req);
        trackUploadInFlight(req);
        file.stream.once("limit", (): void => {
            rejectUpload(req, 413, fileTooLargeError);
            // busboy only ends a truncated file at its closing boundary, so multer would read the whole body first
            file.stream.push(null);
        });
        diskStorage._handleFile(req, file, cb);
    },

    _removeFile: (req, file, cb): void => {
        diskStorage._removeFile(req, file, (error: Error | null): void => {
            if (!rejectedUploads.has(req)) {
                cb(error);
                return;
            }

            discardUpload(get(req, "identity._id"))
                .then((): void => answerRejection(req))
                .catch((answerError: unknown): void => console.error(answerError))
                .finally((): void => cb(error));
        });
    }
};

// multer only answers a rejected upload once the whole body has been read, so watch its parser to answer at once
const streamHandler = (req: express.Request, busboy: Writable): void => {
    let receivedBytes: number = 0;

    req.on("data", (chunk: Buffer): void => {
        receivedBytes += chunk.length;

        if (receivedBytes > maxUploadBytes && !rejectedUploads.has(req)) {
            answerAndClose(req.res, 413, uploadTooLargeError);
        }
    });
    busboy.once("fieldsLimit", (): void => rejectPart(req, "LIMIT_FIELD_COUNT"));
    busboy.once("filesLimit", (): void => rejectPart(req, "LIMIT_FILE_COUNT"));
    busboy.once("partsLimit", (): void => rejectPart(req, "LIMIT_PART_COUNT"));
    busboy.on("field", (field: string, value: string, info: FieldInfo): void => {
        if (field == null) {
            rejectPart(req, "MISSING_FIELD_NAME");
        } else if (info.nameTruncated) {
            rejectPart(req, "LIMIT_FIELD_KEY");
        } else if (info.valueTruncated) {
            rejectPart(req, "LIMIT_FIELD_VALUE", field);
        }
    });
    busboy.on("file", (field: string, stream: Readable, { filename }: { filename?: string }) => {
        if (field == null) {
            rejectPart(req, "MISSING_FIELD_NAME");
        } else if (filename && field !== "file") {
            rejectPart(req, "LIMIT_UNEXPECTED_FILE", field);
        }
    });
    busboy.on("error", (error: NodeJS.ErrnoException): void => {
        if (isMalformedMultipartError(error)) {
            rejectUpload(req, 400, error.message);
        }
    });

    req.pipe(busboy);
};

export const upload: multer.Multer = multer({
    storage: storage,
    defParamCharset: "utf8",
    limits: {
        fileSize: maxFileSizeBytes,
        fields: UPLOAD_MAX_FIELDS,
        files: UPLOAD_MAX_FILES,
        parts: UPLOAD_MAX_FIELDS + UPLOAD_MAX_FILES
    },
    streamHandler
});
