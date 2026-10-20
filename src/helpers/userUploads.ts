import mongoose from "mongoose";

import { UploadVisibility, uploadVisibilities } from "../database/userUploads";

export interface UploadResponse {
    id: string;
    originalFileName: string;
    extension: string;
    mimeType: string;
    fileSize: number;
    visibility: UploadVisibility;
    url: string;
    uploadedOn: string;
    updatedOn: string;
}

interface UploadRecord {
    _id: mongoose.Types.ObjectId;
    originalFileName: string;
    extension: string;
    mimeType: string;
    fileSize: number;
    visibility?: UploadVisibility;
    uploadedBy: mongoose.Types.ObjectId;
    uploadedOn: Date;
    updatedOn: Date;
}

export const toUploadResponse = (upload: UploadRecord): UploadResponse => ({
    id: upload._id.toString(),
    originalFileName: upload.originalFileName,
    extension: upload.extension,
    mimeType: upload.mimeType,
    fileSize: upload.fileSize,
    visibility: upload.visibility ?? "private",
    url: `${process.env.CDN_URL}/useruploads/${upload.uploadedBy}/${upload._id}${upload.extension}`,
    uploadedOn: upload.uploadedOn.toISOString(),
    updatedOn: upload.updatedOn.toISOString()
});

export const isUploadVisibility = (value: unknown): value is UploadVisibility =>
    uploadVisibilities.includes(value as UploadVisibility);

const invalidFileNameCharacters: RegExp = /[\/\\\u0000-\u001f\u007f]/;

export const isUploadFileName = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !invalidFileNameCharacters.test(value);
