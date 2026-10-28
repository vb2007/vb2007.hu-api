import mongoose from "mongoose";

import { EmailCodeSchema } from "./emailCodes";
import { EMAIL_CODE_MAX_ATTEMPTS, EmailCode } from "../helpers/emailCodes";

export interface PendingRegistration {
    username: string;
    email: string;
    authentication: { salt: string; password: string };
    code: EmailCode;
    expiresAt: Date;
}

export const registrationCodeScope = (email: string): string => `registration:${email}`;

const PendingRegistrationSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    authentication: {
        salt: { type: String, required: true },
        password: { type: String, required: true }
    },
    code: {
        type: EmailCodeSchema,
        required: true
    },
    expiresAt: {
        type: Date,
        required: true,
        expires: 0
    }
});

export const PendingRegistrationModel = mongoose.model(
    "PendingRegistration",
    PendingRegistrationSchema
);

export const getPendingRegistration = (email: string) =>
    PendingRegistrationModel.findOne({ email: { $eq: email } }).lean();

export const savePendingRegistration = (values: PendingRegistration, resendBefore: Date) =>
    PendingRegistrationModel.updateOne(
        { email: { $eq: values.email }, "code.sentAt": { $lte: resendBefore } },
        { $set: values },
        { upsert: true }
    );

export const replacePendingRegistrationCode = (
    email: string,
    code: EmailCode,
    resendBefore: Date
) =>
    PendingRegistrationModel.updateOne(
        { email: { $eq: email }, "code.sentAt": { $lte: resendBefore } },
        { $set: { code } }
    );

export const allowPendingRegistrationResend = (email: string) =>
    PendingRegistrationModel.updateOne(
        { email: { $eq: email } },
        { $set: { "code.sentAt": new Date(0) } }
    );

export const claimPendingRegistrationCode = (email: string) =>
    PendingRegistrationModel.findOneAndUpdate(
        {
            email: { $eq: email },
            "code.expiresAt": { $gt: new Date() },
            "code.attempts": { $lt: EMAIL_CODE_MAX_ATTEMPTS }
        },
        { $inc: { "code.attempts": 1 } },
        { new: true }
    ).lean();

export const deletePendingRegistration = (email: string) =>
    PendingRegistrationModel.deleteOne({ email: { $eq: email } });
