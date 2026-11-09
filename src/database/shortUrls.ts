import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { findUserIdsByUsernamePart } from "./users";
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
ShortUrlSchema.index({ addedOn: -1, _id: -1 });

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

type ShortUrlFilter = mongoose.FilterQuery<mongoose.InferSchemaType<typeof ShortUrlSchema>>;

const findShortUrlPage = (
    filter: ShortUrlFilter,
    { limit, page, sortBy, sortOrder }: ShortUrlListOptions
) => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;

    return ShortUrlModel.find(filter)
        .sort({ [sortBy]: sortDirection, _id: sortDirection })
        .skip((page - 1) * limit)
        .limit(limit);
};

export const findShortUrlsByUser = (
    userId: mongoose.Types.ObjectId | string,
    options: ShortUrlListOptions
) => {
    const pattern = options.q && { $regex: escapeRegExp(options.q), $options: "i" };
    const filter = {
        addedBy: { $eq: userId },
        ...(pattern && { $or: [{ shortenedUrl: pattern }, { originalUrl: pattern }] })
    };

    const shortUrlsQuery = findShortUrlPage(filter, options)
        .select("shortenedUrl originalUrl addedOn -_id")
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

export interface ShortUrlWithOwner {
    shortenedUrl: string;
    originalUrl: string;
    addedOn: Date;
    addedBy: { _id: mongoose.Types.ObjectId; username: string } | null;
}

const shortUrlSearchFilter = async (q: string) => {
    const pattern = { $regex: escapeRegExp(q), $options: "i" };

    return {
        $or: [
            { shortenedUrl: pattern },
            { originalUrl: pattern },
            { addedBy: { $in: await findUserIdsByUsernamePart(q) } }
        ]
    };
};

export const findShortUrls = async (options: ShortUrlListOptions) => {
    const filter = options.q ? await shortUrlSearchFilter(options.q) : {};

    const shortUrlsQuery = findShortUrlPage(filter, options)
        .populate<Pick<ShortUrlWithOwner, "addedBy">>("addedBy", "username")
        .lean<ShortUrlWithOwner[]>();

    return Promise.all([shortUrlsQuery.exec(), ShortUrlModel.countDocuments(filter).exec()]);
};
