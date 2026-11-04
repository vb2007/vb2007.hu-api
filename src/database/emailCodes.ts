import mongoose from "mongoose";
import { pick } from "lodash";

import { codeFailuresWindowStart } from "../helpers/emailCodes";

const emailCodeFields = {
    hash: { type: String, required: true },
    sentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    failures: { count: Number, since: Date }
} as const;

export const EmailCodeSchema = new mongoose.Schema(emailCodeFields, { _id: false });

export const EmailChangeSchema = new mongoose.Schema(
    { ...emailCodeFields, email: { type: String, required: true } },
    { _id: false }
);

const emailCodeKeys: string[] = ["hash", "sentAt", "expiresAt", "attempts", "email"];

export const setEmailCodeFields = (field: string, code: object): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(pick(code, emailCodeKeys)).map(([key, value]) => [`${field}.${key}`, value])
    );

export const clearEmailCodeFields = (field: string): mongoose.PipelineStage.Set[] => [
    {
        $set: {
            [field]: {
                $cond: [
                    { $gt: [`$${field}.failures.count`, null] },
                    { failures: `$${field}.failures` },
                    "$$REMOVE"
                ]
            }
        }
    }
];

export const countCodeFailure = (field: string): mongoose.PipelineStage.Set[] => {
    const failures: string = `${field}.failures`;

    return [
        {
            $set: {
                [failures]: {
                    $cond: [
                        { $gt: [`$${failures}.since`, codeFailuresWindowStart()] },
                        { count: { $add: [`$${failures}.count`, 1] }, since: `$${failures}.since` },
                        { count: 1, since: new Date() }
                    ]
                }
            }
        }
    ];
};
