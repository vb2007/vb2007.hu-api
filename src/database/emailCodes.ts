import mongoose from "mongoose";

const emailCodeFields = {
    hash: { type: String, required: true },
    sentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 }
} as const;

export const EmailCodeSchema = new mongoose.Schema(emailCodeFields, { _id: false });

export const EmailChangeSchema = new mongoose.Schema(
    { ...emailCodeFields, email: { type: String, required: true } },
    { _id: false }
);
