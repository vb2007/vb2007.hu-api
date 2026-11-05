import express from "express";

import {
    countUsers,
    findUsersWithUploadUsage,
    getUserById,
    getUserUploadQuota,
    updateUserById
} from "../database/users";
import { findUploadsByUser, getUploadTotalsByVisibility } from "../database/userUploads";
import { countPastes } from "../database/pastebin";
import { countShortUrls } from "../database/shortUrls";
import { countPendingRegistrations } from "../database/pendingRegistrations";
import { Responses } from "../constants/responses";
import {
    findInvalidUserListParam,
    isUploadQuota,
    toAdminUser,
    toUploadTotals,
    toUserListOptions
} from "../helpers/admin";
import { isDuplicateKeyError, validateMongooseId } from "../helpers/mongoose";
import { maxFileSizeBytes } from "../helpers/multer";
import { calculateUploadUsage, defaultUploadQuotaBytes } from "../helpers/uploadQuota";
import { isUsernameTaken, usernameLengthError } from "../helpers/username";
import {
    findInvalidUploadListParam,
    toUploadListOptions,
    toUploadPagination,
    toUploadResponse
} from "../helpers/userUploads";

export const listUsers = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
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
        return next(error);
    }
};

export const updateUserUploadQuota = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
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
        return next(error);
    }
};

export const renameUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const user = await getUserById(id);

        if (!user) {
            return res.status(404).json({ error: Responses.Admin.userNotFound });
        }

        const { username } = req.body ?? {};

        if (typeof username !== "string" || !username) {
            return res.status(400).json({ error: Responses.Users.missingUsername });
        }

        const usernameError: string | null = usernameLengthError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        if (await isUsernameTaken(username, user._id.toString())) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        user.username = username;
        await user.save();

        const [renamedUser, usage] = await Promise.all([
            getUserUploadQuota(id),
            calculateUploadUsage(id)
        ]);

        return res.status(200).json({
            message: Responses.Admin.userRenamedSuccess,
            user: toAdminUser(renamedUser, usage)
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        return next(error);
    }
};

export const listUserUploads = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
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
        return next(error);
    }
};

export const getStats = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const [users, pastes, shortUrls, uploadGroups, pendingRegistrations] = await Promise.all([
            countUsers(),
            countPastes(),
            countShortUrls(),
            getUploadTotalsByVisibility(),
            countPendingRegistrations()
        ]);

        return res.status(200).json({
            users,
            pastes,
            shortUrls,
            uploads: toUploadTotals(uploadGroups),
            pendingRegistrations,
            settings: { defaultUploadQuotaBytes, maxFileSizeBytes }
        });
    } catch (error) {
        return next(error);
    }
};
