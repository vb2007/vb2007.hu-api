import mongoose from "mongoose";

import { CODE_FAILURES_PER_DAY, codeFailuresWindowStart } from "../helpers/emailCodes";

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

export const CodeFailuresSchema = new mongoose.Schema(
    {
        count: { type: Number, required: true },
        since: { type: Date, required: true }
    },
    { _id: false }
);

export const belowFailureCap = (field: string) => ({
    $or: [
        { [field]: { $exists: false } },
        { [`${field}.count`]: { $lt: CODE_FAILURES_PER_DAY } },
        { [`${field}.since`]: { $lte: codeFailuresWindowStart() } }
    ]
});

export const claimCodeCountingFailure = (
    codeField: string,
    failuresField: string
): mongoose.PipelineStage.Set[] => [
    {
        $set: {
            [`${codeField}.attempts`]: { $add: [`$${codeField}.attempts`, 1] },
            [failuresField]: {
                $cond: [
                    { $gt: [`$${failuresField}.since`, codeFailuresWindowStart()] },
                    {
                        count: { $add: [`$${failuresField}.count`, 1] },
                        since: `$${failuresField}.since`
                    },
                    { count: 1, since: new Date() }
                ]
            }
        }
    }
];
