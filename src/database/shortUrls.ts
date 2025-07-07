import mongoose from "mongoose";

const ShortUrlSchema = new mongoose.Schema({
    originalUrl: {
        type: String,
        required: true,
        minlength: 4,
        maxlength: 2000,
        unique: true
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

export const ShortUrlModel = mongoose.model("ShortUrls", ShortUrlSchema);

export const getOriginalUrl = (shortenedUrl: string) => ShortUrlModel.findOne({ shortenedUrl });
export const getShortUrl = (originalUrl: string) => ShortUrlModel.findOne({ originalUrl });
export const createShortUrl = (values: Record<string, any>) =>
    new ShortUrlModel(values).save().then((originalUrl) => originalUrl.toObject());
export const deleteByShortUrl = (shortenedUrl: string) =>
    ShortUrlModel.findOneAndDelete({ shortenedUrl });
export const checkIfShortUrlIsOwnedByUser = async (shortenedUrl: string, userId: string) => {
    const shortUrl: boolean = await ShortUrlModel.findOne({ shortenedUrl, addedBy: userId });
    return !!shortUrl;
};
