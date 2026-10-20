import mongoose from "mongoose";

export interface UploadResponse {
    id: string;
    originalFileName: string;
    extension: string;
    mimeType: string;
    fileSize: number;
    visibility: "public" | "private";
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
    visibility: "private",
    url: `${process.env.CDN_URL}/useruploads/${upload.uploadedBy}/${upload._id}${upload.extension}`,
    uploadedOn: upload.uploadedOn.toISOString(),
    updatedOn: upload.updatedOn.toISOString()
});
