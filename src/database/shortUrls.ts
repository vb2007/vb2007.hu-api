import mongoose from "mongoose";

import { SHORT_URL_MAX_LENGTH } from "../constants/limits";

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

export const createShortUrl = (values: Record<string, any>) =>
    new ShortUrlModel(values).save().then((originalUrl) => originalUrl.toObject());

export const deleteByShortUrl = (shortenedUrl: string) =>
    ShortUrlModel.findOneAndDelete({ shortenedUrl: { $eq: shortenedUrl } });

export const deleteShortUrlsByUser = (userId: mongoose.Types.ObjectId | string) =>
    ShortUrlModel.deleteMany({ addedBy: userId });
