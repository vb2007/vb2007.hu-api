import mongoose from "mongoose";

export const EmailCodeSchema = new mongoose.Schema(
    {
        hash: { type: String, required: true },
        sentAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        attempts: { type: Number, default: 0 }
    },
    { _id: false }
);
