import express from "express";

import {
    findUsersWithUploadUsage,
    getUserById,
    getUserUploadQuota,
    updateUserById
} from "../database/users";
import { findUploadsByUser } from "../database/userUploads";
import { Responses } from "../constants/responses";
import {
    findInvalidUserListParam,
    isUploadQuota,
    toAdminUser,
    toUserListOptions
} from "../helpers/admin";
import { validateMongooseId } from "../helpers/mongoose";
import { calculateUploadUsage } from "../helpers/uploadQuota";
import {
    findInvalidUploadListParam,
    toUploadListOptions,
    toUploadPagination,
    toUploadResponse
} from "../helpers/userUploads";

export const listUsers = async (req: express.Request, res: express.Response) => {
    try {
        const invalidParam: string | undefined = findInvalidUserListParam(req.query);

        if (invalidParam) {
            return res.status(400).json({ error: Responses.Admin.invalidQuery(invalidParam) });
        }

        const options = toUserListOptions(req.query);

        const [users, total] = await findUsersWithUploadUsage(options);

        return res.status(200).json({
            users: users.map((user) => toAdminUser(user, user.uploadUsage)),
            pagination: {
                limit: options.limit,
                page: options.page,
                total,
                pages: Math.ceil(total / options.limit),
                sortBy: options.sortBy,
                sortOrder: options.sortOrder
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const updateUserUploadQuota = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        if (!(await getUserUploadQuota(id))) {
            return res.status(404).json({ error: Responses.Admin.userNotFound });
        }

        const { quotaBytes } = req.body ?? {};

        if (!isUploadQuota(quotaBytes)) {
            return res.status(400).json({ error: Responses.Admin.invalidQuota });
        }

        await updateUserById(id, { uploadQuotaBytes: quotaBytes });

        const [user, usage] = await Promise.all([getUserUploadQuota(id), calculateUploadUsage(id)]);

        return res
            .status(200)
            .json({ message: Responses.Admin.quotaUpdatedSuccess, user: toAdminUser(user, usage) });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const listUserUploads = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const invalidParam: string | undefined = findInvalidUploadListParam(req.query);

        if (invalidParam) {
            return res
                .status(400)
                .json({ error: Responses.UserUploads.invalidQuery(invalidParam) });
        }

        const user = await getUserById(id);

        if (!user) {
            return res.status(404).json({ error: Responses.Admin.userNotFound });
        }

        const options = toUploadListOptions(req.query);

        const [uploads, total] = await findUploadsByUser(id, options);

        return res.status(200).json({
            user: { id: user._id.toString(), username: user.username },
            uploads: uploads.map(toUploadResponse),
            pagination: toUploadPagination(options, total)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};
