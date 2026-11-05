import mongoose from "mongoose";

import { CODE_FAILURES_PER_DAY } from "../constants/limits";
import { codeFailuresWindowStart } from "../helpers/emailCodes";

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

export const failureCountingClaim = (codeField: string, failuresField: string) => {
    const windowStart: Date = codeFailuresWindowStart();
    const failures = (key: string): string => `$${failuresField}.${key}`;

    const countGuess: mongoose.PipelineStage.Set[] = [
        {
            $set: {
                [`${codeField}.attempts`]: { $add: [`$${codeField}.attempts`, 1] },
                [failuresField]: {
                    $cond: [
                        { $gt: [failures("since"), windowStart] },
                        { count: { $add: [failures("count"), 1] }, since: failures("since") },
                        { count: 1, since: new Date() }
                    ]
                }
            }
        }
    ];

    return {
        belowCap: {
            $or: [
                { [`${failuresField}.count`]: { $not: { $gte: CODE_FAILURES_PER_DAY } } },
                { [`${failuresField}.since`]: { $lte: windowStart } }
            ]
        },
        countGuess
    };
};
