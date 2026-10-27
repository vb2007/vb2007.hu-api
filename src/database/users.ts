import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { SortOrder, UserUploadsModel } from "./userUploads";
import { EmailCodeSchema } from "./emailCodes";
import { EMAIL_CODE_MAX_ATTEMPTS, EmailCode } from "../helpers/emailCodes";

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
        match: /^\S+@\S+\.\S+$/,
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

export const getUserBySessionToken = (sessionToken: string) =>
    UserModel.findOne({
        "authentication.sessionToken": { $eq: sessionToken }
    });

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

export const setPasswordIfUnset = (
    id: string,
    sessionToken: string,
    salt: string,
    password: string,
    githubVerifiedSince: Date
) =>
    UserModel.updateOne(
        {
            _id: id,
            "authentication.sessionToken": { $eq: sessionToken },
            "authentication.password": { $in: [null, ""] },
            "authentication.githubVerifiedAt": { $gte: githubVerifiedSince, $lte: new Date() }
        },
        {
            $set: { "authentication.salt": salt, "authentication.password": password },
            $unset: { "authentication.githubVerifiedAt": 1 }
        }
    );

export const passwordResetScope = (id: string): string => `passwordReset:${id}`;

export const setPasswordResetCode = (id: string, code: EmailCode, resendBefore: Date) =>
    UserModel.updateOne(
        {
            _id: id,
            $or: [
                { "authentication.passwordReset": { $exists: false } },
                { "authentication.passwordReset.sentAt": { $lte: resendBefore } }
            ]
        },
        { $set: { "authentication.passwordReset": code } }
    );

export const allowPasswordResetResend = (id: string) =>
    UserModel.updateOne(
        { _id: id },
        { $set: { "authentication.passwordReset.sentAt": new Date(0) } }
    );

export const claimPasswordResetCode = (email: string) =>
    UserModel.findOneAndUpdate(
        {
            email: { $eq: email },
            "authentication.passwordReset.expiresAt": { $gt: new Date() },
            "authentication.passwordReset.attempts": { $lt: EMAIL_CODE_MAX_ATTEMPTS }
        },
        { $inc: { "authentication.passwordReset.attempts": 1 } },
        { new: true }
    )
        .select("+authentication.passwordReset")
        .lean();

export const resetPassword = (id: string, codeHash: string, salt: string, password: string) =>
    UserModel.updateOne(
        { _id: id, "authentication.passwordReset.hash": { $eq: codeHash } },
        {
            $set: {
                "authentication.salt": salt,
                "authentication.password": password,
                "authentication.emailVerifiedAt": new Date()
            },
            $unset: { "authentication.passwordReset": 1, "authentication.sessionToken": 1 }
        }
    );
