import mongoose from "mongoose";

const ShortUrlSchema = new mongoose.Schema({
    originalUrl: {
        type: String,
        required: true
    },
    shortenedUrl: {
        type: String,
        required: true
    },
    addedBy: {
        type: String,
        required: false
    },
    addedOn: {
        type: Date,
        default: Date.now,
        required: false
    }
});

export const ShortUrlModel = mongoose.model("ShortUrls", ShortUrlSchema);

export const getOriginalUrl = (shortenedUrl: string) => ShortUrlModel.findOne({ shortenedUrl });
export const createShortUrl = (values: Record<string, any>) => new ShortUrlModel(values)
    .save().then((originalUrl) => originalUrl.toObject());