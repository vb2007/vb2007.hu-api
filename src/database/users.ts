import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { SortOrder, UserUploadsModel } from "./userUploads";
import {
    CodeFailuresSchema,
    EmailChangeSchema,
    EmailCodeSchema,
    failureCountingClaim
} from "./emailCodes";
import { EmailCode } from "../helpers/emailCodes";
import { EMAIL_CODE_MAX_ATTEMPTS } from "../constants/limits";
import { hashSessionToken, isValidEmail } from "../helpers";

export const userSortFields = ["usedBytes", "username", "createdAt"] as const;

export type UserSortField = (typeof userSortFields)[number];

export interface UserListOptions {
    limit: number;
    page: number;
    sortBy: UserSortField;
    sortOrder: SortOrder;
    q?: string;
}

export interface UserWithUploadUsage {
    _id: mongoose.Types.ObjectId;
    username: string;
    email: string;
    createdAt?: Date;
    uploadQuotaBytes?: number | null;
    uploadUsage: { usedBytes: number; count: number };
}

export const usernameCollation: mongoose.mongo.CollationOptions = { locale: "en", strength: 2 };

export interface ExpiringHash {
    hash: string;
    expiresAt: Date;
}

const ExpiringHashSchema = new mongoose.Schema(
    {
        hash: { type: String, required: true },
        expiresAt: { type: Date, required: true }
    },
    { _id: false }
);

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        minlength: 2,
        maxlength: 16,
        trim: true
    },
    email: {
        type: String,
        required: true,
        validate: {
            validator: function (this: mongoose.Document, email: string): boolean {
                return !this.isModified("email") || isValidEmail(email);
            }
        },
        unique: true
    },
    authentication: {
        password: {
            type: String,
            select: false //for avoiding fetching sensitive user credentials by accident
        },
        salt: {
            type: String,
            select: false
        },
        sessionToken: {
            type: String,
            select: false
        },
        sessionExpiresAt: {
            type: Date,
            select: false
        },
        githubVerifiedAt: {
            type: Date,
            select: false
        },
        emailVerifiedAt: {
            type: Date,
            select: false
        },
        passwordReset: {
            type: EmailCodeSchema,
            select: false
        },
        passwordResetFailures: {
            type: CodeFailuresSchema,
            select: false
        },
        emailChange: {
            type: EmailChangeSchema,
            select: false
        },
        emailChangeFailures: {
            type: CodeFailuresSchema,
            select: false
        },
        passwordResetLinks: {
            type: [ExpiringHashSchema],
            default: undefined,
            select: false
        },
        githubLink: {
            type: ExpiringHashSchema,
            select: false
        }
    },
    githubId: {
        type: String,
        unique: true,
        sparse: true
    },
    githubLogin: {
        type: String
    },
    uploadQuotaBytes: {
        type: Number,
        default: null,
        select: false
    },
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

UserSchema.index({ username: 1 }, { unique: true, collation: usernameCollation });

export const UserModel = mongoose.model("User", UserSchema);

export const getUserByEmail = (email: string) => UserModel.findOne({ email: { $eq: email } });

export const getUserByUsername = (username: string) =>
    UserModel.findOne({ username: { $eq: username } }).collation(usernameCollation);

export const getUserByGithubId = (githubId: string) =>
    UserModel.findOne({ githubId: { $eq: githubId } });

const activeSessionFilter = (sessionToken: string) => ({
    "authentication.sessionToken": { $eq: hashSessionToken(sessionToken) },
    "authentication.sessionExpiresAt": { $gt: new Date() }
});

export const getUserBySessionToken = (sessionToken: string) =>
    UserModel.findOne(activeSessionFilter(sessionToken));

export const getUserById = (id: string) => UserModel.findById(id);

export const getUserUploadQuota = (id: mongoose.Types.ObjectId | string) =>
    UserModel.findById(id).select("+uploadQuotaBytes").lean();

const uploadUsageStages: mongoose.PipelineStage.FacetPipelineStage[] = [
    {
        $lookup: {
            from: UserUploadsModel.collection.name,
            let: { userId: "$_id" },
            pipeline: [
                { $match: { $expr: { $eq: ["$uploadedBy", "$$userId"] } } },
                { $group: { _id: null, bytes: { $sum: "$fileSize" }, count: { $sum: 1 } } }
            ],
            as: "uploadGroups"
        }
    },
    {
        $set: {
            uploadUsage: {
                usedBytes: { $sum: "$uploadGroups.bytes" },
                count: { $sum: "$uploadGroups.count" }
            }
        }
    }
];

export const findUsersWithUploadUsage = async ({
    limit,
    page,
    sortBy,
    sortOrder,
    q
}: UserListOptions): Promise<[UserWithUploadUsage[], number]> => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const sortKey: string = sortBy === "usedBytes" ? "uploadUsage.usedBytes" : sortBy;

    const pageStages: mongoose.PipelineStage.FacetPipelineStage[] = [
        { $sort: { [sortKey]: sortDirection, _id: sortDirection } },
        { $skip: (page - 1) * limit },
        { $limit: limit }
    ];

    const userStages: mongoose.PipelineStage.FacetPipelineStage[] =
        sortBy === "usedBytes"
            ? [...uploadUsageStages, ...pageStages]
            : [...pageStages, ...uploadUsageStages];

    const usersAggregate = UserModel.aggregate<{
        users: UserWithUploadUsage[];
        total: { count: number }[];
    }>([
        { $match: q ? { username: { $regex: escapeRegExp(q), $options: "i" } } : {} },
        { $set: { createdAt: { $ifNull: ["$createdAt", { $toDate: "$_id" }] } } },
        {
            $facet: {
                users: [
                    ...userStages,
                    {
                        $project: {
                            _id: 1,
                            username: 1,
                            email: 1,
                            createdAt: 1,
                            uploadQuotaBytes: 1,
                            uploadUsage: 1
                        }
                    }
                ],
                total: [{ $count: "count" }]
            }
        }
    ]);

    if (sortBy === "username") {
        usersAggregate.collation(usernameCollation);
    }

    const [{ users, total }] = await usersAggregate.exec();

    return [users, total[0]?.count ?? 0];
};

export const createUser = (values: Record<string, any>) =>
    new UserModel(values).save().then((user) => user.toObject());

export const deleteUserById = (id: string) => UserModel.findByIdAndDelete({ _id: id });

export const updateUserById = (id: string, values: Record<string, any>) =>
    UserModel.findByIdAndUpdate(id, values);

const githubVerifiedSessionFilter = (
    id: string,
    sessionToken: string,
    githubVerifiedSince: Date
) => ({
    _id: id,
    ...activeSessionFilter(sessionToken),
    "authentication.password": { $in: [null, ""] },
    "authentication.githubVerifiedAt": { $gte: githubVerifiedSince, $lte: new Date() }
});

const passwordResetFields = {
    "authentication.passwordReset": 1,
    "authentication.passwordResetLinks": 1
};

export const setPasswordIfUnset = (
    id: string,
    sessionToken: string,
    salt: string,
    password: string,
    githubVerifiedSince: Date
) =>
    UserModel.updateOne(githubVerifiedSessionFilter(id, sessionToken, githubVerifiedSince), {
        $set: { "authentication.salt": salt, "authentication.password": password },
        $unset: { "authentication.githubVerifiedAt": 1, ...passwordResetFields }
    });

export const replacePasswordHash = (
    id: string,
    previousPassword: string,
    salt: string,
    password: string
) =>
    UserModel.updateOne(
        { _id: id, "authentication.password": { $eq: previousPassword } },
        { $set: { "authentication.salt": salt, "authentication.password": password } }
    );

export const deleteGithubVerifiedUser = (
    id: string,
    sessionToken: string,
    githubVerifiedSince: Date
) => UserModel.deleteOne(githubVerifiedSessionFilter(id, sessionToken, githubVerifiedSince));

export const setGithubLinkProof = (id: string, proof: ExpiringHash) =>
    UserModel.updateOne({ _id: id }, { $set: { "authentication.githubLink": proof } });

export const claimGithubLinkProof = (id: string, sessionTokenHash: string, hash: string) =>
    UserModel.updateOne(
        {
            _id: id,
            "authentication.sessionToken": { $eq: sessionTokenHash },
            "authentication.githubLink.hash": { $eq: hash },
            "authentication.githubLink.expiresAt": { $gt: new Date() }
        },
        { $unset: { "authentication.githubLink": 1 } }
    );

export const linkGithubAccount = (id: string, githubId: string, githubLogin: string) =>
    UserModel.updateOne(
        { _id: id, githubId: { $in: [null, githubId] } },
        {
            $set: {
                githubId,
                githubLogin,
                "authentication.githubVerifiedAt": new Date()
            }
        }
    );

export const passwordResetScope = (id: string, email: string): string =>
    `passwordReset:${id}:${email}`;

export const passwordResetLinkScope = (id: string): string => `passwordResetLink:${id}`;

const restoreEmailCode = (
    id: string,
    field: string,
    code: EmailCode,
    previous: EmailCode | undefined
) =>
    UserModel.updateOne(
        {
            _id: id,
            [`${field}.hash`]: { $eq: code.hash },
            [`${field}.sentAt`]: { $eq: code.sentAt }
        },
        previous ? { $set: { [field]: previous } } : { $unset: { [field]: 1 } }
    );

export const setPasswordReset = (
    id: string,
    email: string,
    code: EmailCode,
    link: ExpiringHash,
    linksKept: number,
    resendBefore: Date
) =>
    UserModel.findOneAndUpdate(
        {
            _id: id,
            email: { $eq: email },
            $or: [
                { "authentication.passwordReset": { $exists: false } },
                { "authentication.passwordReset.sentAt": { $lte: resendBefore } }
            ]
        },
        [
            {
                $set: {
                    "authentication.passwordReset": { $literal: code },
                    "authentication.passwordResetLinks": {
                        $slice: [
                            {
                                $concatArrays: [
                                    {
                                        $filter: {
                                            input: {
                                                $ifNull: ["$authentication.passwordResetLinks", []]
                                            },
                                            cond: { $gt: ["$$this.expiresAt", "$$NOW"] }
                                        }
                                    },
                                    [{ $literal: link }]
                                ]
                            },
                            -linksKept
                        ]
                    }
                }
            }
        ],
        { new: false }
    )
        .select("+authentication.passwordReset")
        .lean();

export const restorePasswordReset = async (
    id: string,
    code: EmailCode,
    link: ExpiringHash,
    previous: EmailCode | undefined
) => {
    await UserModel.updateOne(
        { _id: id },
        { $pull: { "authentication.passwordResetLinks": { hash: { $eq: link.hash } } } }
    );
    await restoreEmailCode(id, "authentication.passwordReset", code, previous);
};

export const claimPasswordResetCode = (email: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.passwordReset",
        "authentication.passwordResetFailures"
    );

    return UserModel.findOneAndUpdate(
        {
            email: { $eq: email },
            "authentication.passwordReset.expiresAt": { $gt: new Date() },
            "authentication.passwordReset.attempts": { $lt: EMAIL_CODE_MAX_ATTEMPTS },
            ...belowCap
        },
        countGuess,
        { new: true }
    )
        .select("+authentication.passwordReset")
        .lean();
};

const passwordResetUpdate = (salt: string, password: string) => ({
    $set: {
        "authentication.salt": salt,
        "authentication.password": password,
        "authentication.emailVerifiedAt": new Date()
    },
    $unset: {
        ...passwordResetFields,
        "authentication.passwordResetFailures": 1,
        "authentication.sessionToken": 1,
        "authentication.sessionExpiresAt": 1
    }
});

export const resetPassword = (id: string, codeHash: string, salt: string, password: string) =>
    UserModel.updateOne(
        { _id: id, "authentication.passwordReset.hash": { $eq: codeHash } },
        passwordResetUpdate(salt, password)
    );

const livePasswordResetLink = (id: string, linkHash: string) => ({
    _id: id,
    "authentication.passwordResetLinks": {
        $elemMatch: { hash: { $eq: linkHash }, expiresAt: { $gt: new Date() } }
    }
});

export const hasPasswordResetLink = async (id: string, linkHash: string): Promise<boolean> =>
    Boolean(await UserModel.exists(livePasswordResetLink(id, linkHash)));

export const resetPasswordWithLink = (
    id: string,
    linkHash: string,
    salt: string,
    password: string
) =>
    UserModel.findOneAndUpdate(
        livePasswordResetLink(id, linkHash),
        passwordResetUpdate(salt, password),
        { new: false }
    ).lean();

export const emailChangeScope = (id: string, email: string): string => `emailChange:${id}:${email}`;

export type EmailChange = EmailCode & { email: string };

export const setEmailChange = (id: string, change: EmailChange, resendBefore: Date) =>
    UserModel.findOneAndUpdate(
        {
            _id: id,
            $or: [
                { "authentication.emailChange": { $exists: false } },
                { "authentication.emailChange.sentAt": { $lte: resendBefore } }
            ]
        },
        { $set: { "authentication.emailChange": change } },
        { new: false }
    )
        .select("+authentication.emailChange")
        .lean();

export const restoreEmailChange = (
    id: string,
    change: EmailChange,
    previous: EmailChange | undefined
) => restoreEmailCode(id, "authentication.emailChange", change, previous);

export const getEmailChange = (id: string) =>
    UserModel.findById(id).select("+authentication.emailChange").lean();

export const claimEmailChangeCode = (id: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.emailChange",
        "authentication.emailChangeFailures"
    );

    return UserModel.findOneAndUpdate(
        {
            _id: id,
            "authentication.emailChange.expiresAt": { $gt: new Date() },
            "authentication.emailChange.attempts": { $lt: EMAIL_CODE_MAX_ATTEMPTS },
            ...belowCap
        },
        countGuess,
        { new: true }
    )
        .select("+authentication.emailChange +authentication.emailChangeFailures")
        .lean();
};

export const getEmailChangeFailures = (id: string) =>
    UserModel.findById(id).select("+authentication.emailChangeFailures").lean();

export const uncountEmailChangeFailure = (id: string, since: Date) =>
    UserModel.updateOne(
        {
            _id: id,
            "authentication.emailChangeFailures.since": { $eq: since },
            "authentication.emailChangeFailures.count": { $gt: 0 }
        },
        { $inc: { "authentication.emailChangeFailures.count": -1 } }
    );

export const applyEmailChange = (id: string, codeHash: string, email: string) =>
    UserModel.updateOne(
        { _id: id, "authentication.emailChange.hash": { $eq: codeHash } },
        {
            $set: { email, "authentication.emailVerifiedAt": new Date() },
            $unset: { "authentication.emailChange": 1, ...passwordResetFields }
        }
    );

export const clearEmailChange = (id: string) =>
    UserModel.updateOne({ _id: id }, { $unset: { "authentication.emailChange": 1 } });
