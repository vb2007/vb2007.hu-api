import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { ALLOWED_UPLOAD_TYPES, UploadCategory } from "../constants/uploads";

export const uploadVisibilities = ["public", "private"] as const;

export type UploadVisibility = (typeof uploadVisibilities)[number];

export const uploadSortFields = ["uploadedOn", "originalFileName", "fileSize"] as const;

export type UploadSortField = (typeof uploadSortFields)[number];

export const sortOrders = ["asc", "desc"] as const;

export type SortOrder = (typeof sortOrders)[number];

export interface UploadListOptions {
    limit: number;
    page: number;
    sortBy: UploadSortField;
    sortOrder: SortOrder;
    visibility?: UploadVisibility;
    q?: string;
}

const UserUploadsSchema = new mongoose.Schema({
    originalFileName: {
        type: String,
        required: true
    },
    storedFileName: {
        type: String,
        required: true
    },
    filePath: {
        type: String,
        required: true
    },
    extension: {
        type: String,
        required: true
    },
    fileSize: {
        type: Number,
        required: true
    },
    mimeType: {
        type: String,
        required: true
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    visibility: {
        type: String,
        enum: uploadVisibilities,
        default: "private",
        index: true
    },
    uploadedOn: {
        type: Date,
        default: Date.now,
        immutable: true
    },
    updatedOn: {
        type: Date,
        default: Date.now
    }
});

UserUploadsSchema.index({ uploadedBy: 1, uploadedOn: -1 });

export const UserUploadsModel = mongoose.model("UserUploads", UserUploadsSchema);

export const getUploadById = (id: string) => UserUploadsModel.findById(id);

export const getUploadAccessById = (id: string) =>
    UserUploadsModel.findById(id).select("uploadedBy visibility extension originalFileName").lean();

export const createUserUpload = (values: {
    _id: mongoose.Types.ObjectId;
    originalFileName: string;
    uploadedBy: mongoose.Types.ObjectId | string;
    storedFileName: string;
    filePath: string;
    extension: string;
    fileSize: number;
    mimeType: string;
    visibility: UploadVisibility;
}) => new UserUploadsModel(values).save().then((upload) => upload.toObject());

export const updateUploadById = (
    id: string,
    values: { originalFileName?: string; visibility?: UploadVisibility; updatedOn: Date }
) => UserUploadsModel.findByIdAndUpdate(id, values, { new: true });

export const findUploadsByUser = (
    userId: mongoose.Types.ObjectId | string,
    { limit, page, sortBy, sortOrder, visibility, q }: UploadListOptions
) => {
    const filter = {
        uploadedBy: userId,
        ...(visibility && { visibility }),
        ...(q && { originalFileName: { $regex: escapeRegExp(q), $options: "i" } })
    };

    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const uploadsQuery = UserUploadsModel.find(filter)
        .sort({ [sortBy]: sortDirection, _id: sortDirection })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

    if (sortBy === "originalFileName") {
        uploadsQuery.collation({ locale: "en", strength: 2 });
    }

    return Promise.all([uploadsQuery.exec(), UserUploadsModel.countDocuments(filter).exec()]);
};

const uploadCategoryExpression = {
    $switch: {
        branches: ALLOWED_UPLOAD_TYPES.map(({ mimeType, category }) => ({
            case: { $eq: ["$mimeType", mimeType] },
            then: category
        })),
        default: "document"
    }
};

export const getUploadUsageByUser = (userId: mongoose.Types.ObjectId | string) =>
    UserUploadsModel.aggregate<{ _id: UploadCategory; bytes: number; count: number }>([
        { $match: { uploadedBy: new mongoose.Types.ObjectId(userId) } },
        {
            $group: {
                _id: uploadCategoryExpression,
                bytes: { $sum: "$fileSize" },
                count: { $sum: 1 }
            }
        }
    ]);

export const deleteUploadById = (id: string) => UserUploadsModel.findByIdAndDelete(id);

export const deleteUploadsByUser = (userId: mongoose.Types.ObjectId | string) =>
    UserUploadsModel.deleteMany({ uploadedBy: userId });
