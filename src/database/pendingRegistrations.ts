import mongoose from "mongoose";

import { EmailCodeSchema } from "./emailCodes";
import { EMAIL_CODE_MAX_ATTEMPTS, EmailCode } from "../helpers/emailCodes";

export interface PendingRegistration {
    email: string;
    code: EmailCode;
    expiresAt: Date;
}

export const registrationCodeScope = (email: string): string => `registration:${email}`;

const PendingRegistrationSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true
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

export type StoredPendingRegistration = Awaited<ReturnType<typeof getPendingRegistration>>;

export const savePendingRegistration = (values: PendingRegistration, resendBefore: Date) =>
    PendingRegistrationModel.findOneAndUpdate(
        { email: { $eq: values.email }, "code.sentAt": { $lte: resendBefore } },
        { $set: values, $unset: { username: 1, authentication: 1 } },
        { upsert: true, new: false, strict: false }
    ).lean();

export const replacePendingRegistrationCode = (
    email: string,
    code: EmailCode,
    resendBefore: Date
) =>
    PendingRegistrationModel.findOneAndUpdate(
        { email: { $eq: email }, "code.sentAt": { $lte: resendBefore } },
        { $set: { code } },
        { new: false }
    ).lean();

const withCode = (email: string, code: EmailCode) => ({
    email: { $eq: email },
    "code.hash": { $eq: code.hash },
    "code.sentAt": { $eq: code.sentAt }
});

export const restorePendingRegistration = (
    email: string,
    code: EmailCode,
    previous: StoredPendingRegistration
) =>
    previous
        ? PendingRegistrationModel.replaceOne(withCode(email, code), {
              email: previous.email,
              code: previous.code,
              expiresAt: previous.expiresAt
          })
        : PendingRegistrationModel.deleteOne(withCode(email, code));

export const restorePendingRegistrationCode = (
    email: string,
    code: EmailCode,
    previous: EmailCode
) => PendingRegistrationModel.updateOne(withCode(email, code), { $set: { code: previous } });

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
