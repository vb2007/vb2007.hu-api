import mongoose from "mongoose";

import {
    SortOrder,
    UploadListOptions,
    UploadSortField,
    UploadVisibility,
    sortOrders,
    uploadSortFields,
    uploadVisibilities
} from "../database/userUploads";

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
