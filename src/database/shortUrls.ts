import mongoose from "mongoose";

const ShortUrlSchema = new mongoose.Schema({
    originalUrl: {
        type: String,
        required: true,
        minlength: 4,
        maxlength: 2000,
        // unique: true
    },
    shortenedUrl: {
        type: String,
        required: true,
        unique: true
    },
    addedBy: {
        type: String,
        minlegth: 2, //reference: UserSchema.username
        maxlength: 16,
        required: true
    },
    addedOn: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

export const ShortUrlModel = mongoose.model("ShortUrls", ShortUrlSchema);

export const getOriginalUrl = (shortenedUrl: string) => ShortUrlModel.findOne({ shortenedUrl });
export const getShortUrl = (originalUrl: string) => ShortUrlModel.findOne({ originalUrl });
export const createShortUrl = (values: Record<string, any>) => new ShortUrlModel(values)
    .save().then((originalUrl) => originalUrl.toObject());