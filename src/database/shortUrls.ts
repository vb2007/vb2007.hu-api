import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { SHORT_URL_MAX_LENGTH } from "../constants/limits";
import { SortOrder } from "./userUploads";

export const shortUrlSortFields = ["addedOn"] as const;

export type ShortUrlSortField = (typeof shortUrlSortFields)[number];

export interface ShortUrlListOptions {
    limit: number;
    page: number;
    sortBy: ShortUrlSortField;
    sortOrder: SortOrder;
    q?: string;
}

const ShortUrlSchema = new mongoose.Schema({
    originalUrl: {
        type: String,
        required: true,
        minlength: 4,
        maxlength: SHORT_URL_MAX_LENGTH
    },
    shortenedUrl: {
        type: String,
        required: true,
        unique: true
    },
    addedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    addedOn: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

ShortUrlSchema.index({ originalUrl: 1, addedBy: 1 }, { unique: true });
ShortUrlSchema.index({ addedBy: 1, addedOn: -1 });

export const ShortUrlModel = mongoose.model("ShortUrls", ShortUrlSchema);

export const getOriginalUrl = (shortenedUrl: string) =>
    ShortUrlModel.findOne({ shortenedUrl: { $eq: shortenedUrl } });

export const getOriginalUrlWithUser = (shortenedUrl: string) =>
    ShortUrlModel.findOne({ shortenedUrl: { $eq: shortenedUrl } }).populate(
        "addedBy",
        "username createdAt"
    );

export const getShortUrlByUser = (originalUrl: string, userId: mongoose.Types.ObjectId | string) =>
    ShortUrlModel.findOne({ originalUrl: { $eq: originalUrl }, addedBy: userId });

export const countShortUrls = () => ShortUrlModel.countDocuments().exec();

export const findShortUrlsByUser = (
    userId: mongoose.Types.ObjectId | string,
    { limit, page, sortBy, sortOrder, q }: ShortUrlListOptions
) => {
    const pattern = q && { $regex: escapeRegExp(q), $options: "i" };
    const filter = {
        addedBy: { $eq: userId },
        ...(pattern && { $or: [{ shortenedUrl: pattern }, { originalUrl: pattern }] })
    };

    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const shortUrlsQuery = ShortUrlModel.find(filter)
        .select("shortenedUrl originalUrl addedOn -_id")
        .sort({ [sortBy]: sortDirection, _id: sortDirection })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

    return Promise.all([shortUrlsQuery.exec(), ShortUrlModel.countDocuments(filter).exec()]);
};

export const countShortUrlsByUser = (userId: mongoose.Types.ObjectId | string) =>
    ShortUrlModel.countDocuments({ addedBy: userId }).exec();

export const createShortUrl = (values: Record<string, any>) =>
    new ShortUrlModel(values).save().then((originalUrl) => originalUrl.toObject());

export const deleteByShortUrl = (shortenedUrl: string) =>
    ShortUrlModel.findOneAndDelete({ shortenedUrl: { $eq: shortenedUrl } });

export const deleteShortUrlsByUser = (userId: mongoose.Types.ObjectId | string) =>
    ShortUrlModel.deleteMany({ addedBy: userId });
