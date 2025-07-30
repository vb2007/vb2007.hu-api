import mongoose from "mongoose";

const LicenseSchema = new mongoose.Schema({
    licenseKey: {
        type: String,
        required: true,
        unique: true
    },
    uniqueAppId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    usage: {
        isUsed: {
            type: Boolean,
            default: false
        },
        createdAt: {
            type: Date,
            default: Date.now
        },
        usedAt: {
            type: Date
        }
    }
});
