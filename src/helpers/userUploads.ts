import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import {
    SortOrder,
    UploadListOptions,
    UploadSortField,
    UploadVisibility,
    sortOrders,
    uploadSortFields,
    uploadVisibilities
} from "../database/userUploads";
import { getUserById } from "../database/users";
import { UPLOAD_URL_TTL_SECONDS } from "../constants/limits";

dotenv.config();

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

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const uploadUrlKey: Buffer = crypto
    .createHmac("sha256", process.env.CRYPTO_SECRET_KEY)
    .update("upload-url")
    .digest();

const uploadUrlSignature = (uploadPath: string, expires: string): string =>
    crypto
        .createHmac("sha256", uploadUrlKey)
        .update(`${expires}:${uploadPath}`)
        .digest("base64url");

export const signUploadPath = (
    uploadPath: string,
    expires: number = nowSeconds() + UPLOAD_URL_TTL_SECONDS
): string =>
    `${uploadPath}?expires=${expires}&sig=${uploadUrlSignature(uploadPath, String(expires))}`;

export const hasValidUploadSignature = (uploadPath: string, query: URLSearchParams): boolean => {
    const expires: string = query.get("expires") ?? "";

    if (!/^\d{1,15}$/.test(expires) || Number(expires) <= nowSeconds()) {
        return false;
    }

    const expected: Buffer = Buffer.from(uploadUrlSignature(uploadPath, expires));
    const actual: Buffer = Buffer.from(query.get("sig") ?? "");

    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

export const toUploadResponse = (upload: UploadRecord): UploadResponse => {
    const visibility: UploadVisibility = upload.visibility ?? "private";
    const uploadPath: string = `/useruploads/${upload.uploadedBy}/${upload._id}${upload.extension}`;

    return {
        id: upload._id.toString(),
        originalFileName: upload.originalFileName,
        extension: upload.extension,
        mimeType: upload.mimeType,
        fileSize: upload.fileSize,
        visibility,
        url: `${process.env.CDN_URL}${visibility === "public" ? uploadPath : signUploadPath(uploadPath)}`,
        uploadedOn: upload.uploadedOn.toISOString(),
        updatedOn: upload.updatedOn.toISOString()
    };
};

export const toRfc5987FileName = (fileName: string): string =>
    `UTF-8''${encodeURIComponent(fileName).replace(
        /['()*]/g,
        (char: string) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )}`;

export const isUploadVisibility = (value: unknown): value is UploadVisibility =>
    uploadVisibilities.includes(value as UploadVisibility);

const invalidFileNameCharacters: RegExp = /[\/\\\u0000-\u001f\u007f]/;

export const isUploadFileName = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !invalidFileNameCharacters.test(value);

export const isIntegerInRange = (value: unknown, min: number, max: number): boolean =>
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    Number(value) >= min &&
    Number(value) <= max;

const uploadListValidators: Record<keyof UploadListOptions, (value: unknown) => boolean> = {
    limit: (value) => isIntegerInRange(value, 1, 50),
    page: (value) => isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER),
    sortBy: (value) => uploadSortFields.includes(value as UploadSortField),
    sortOrder: (value) => sortOrders.includes(value as SortOrder),
    visibility: isUploadVisibility,
    q: (value) => typeof value === "string" && value.length <= 100
};

export const findInvalidUploadListParam = (query: Record<string, unknown>): string | undefined =>
    Object.keys(uploadListValidators).find(
        (param: keyof UploadListOptions) =>
            query[param] !== undefined && !uploadListValidators[param](query[param])
    );

export const toUploadListOptions = (query: Record<string, unknown>): UploadListOptions => ({
    limit: Number(query.limit ?? 20),
    page: Number(query.page ?? 1),
    sortBy: (query.sortBy ?? "uploadedOn") as UploadSortField,
    sortOrder: (query.sortOrder ?? "desc") as SortOrder,
    visibility: query.visibility as UploadVisibility | undefined,
    q: query.q as string | undefined
});

export const toUploadPagination = (options: UploadListOptions, total: number) => ({
    limit: options.limit,
    page: options.page,
    total,
    pages: Math.ceil(total / options.limit),
    sortBy: options.sortBy,
    sortOrder: options.sortOrder
});

export const removeTempFile = (filePath: string): Promise<void> =>
    fs.promises.rm(filePath, { force: true }).catch((): void => undefined);

export const userStillExists = (userId: string): Promise<boolean> =>
    getUserById(userId).then(Boolean, (): boolean => true);

export const removeUserUploadDir = (userId: mongoose.Types.ObjectId | string): Promise<void> =>
    fs.promises
        .rm(path.join(path.resolve(process.env.UPLOAD_DISK_DIRECTORY), userId.toString()), {
            recursive: true,
            force: true
        })
        .catch((): void => undefined);

export const discardUpload = async (
    userId: mongoose.Types.ObjectId | string,
    filePath?: string
): Promise<void> => {
    if (filePath) {
        await removeTempFile(filePath);
    }

    if (!(await userStillExists(userId.toString()))) {
        await removeUserUploadDir(userId);
    }
};
