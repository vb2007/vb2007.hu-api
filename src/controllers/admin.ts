import express from "express";

import {
    deleteUserById,
    findUserIdsByUsernamePart,
    findUsernamesByIds,
    findUsersWithUploadUsage,
    getUserById,
    getUserUploadQuota,
    updateUserById
} from "../database/users";
import { findUploads, findUploadsByUser } from "../database/userUploads";
import { findShortUrls } from "../database/shortUrls";
import { Responses } from "../constants/responses";
import { isSuperuserEmail } from "../helpers";
import {
    findInvalidUserListParam,
    isUploadQuota,
    toAdminShortUrl,
    toAdminUser,
    toUploadOwners,
    toUserListOptions
} from "../helpers/admin";
import { readMailBudget } from "../helpers/mail";
import { isDuplicateKeyError, validateMongooseId } from "../helpers/mongoose";
import {
    findInvalidShortUrlListParam,
    toShortUrlListOptions,
    toShortUrlPagination
} from "../helpers/shortUrls";
import { calculateUploadUsage } from "../helpers/uploadQuota";
import { removeUserContent } from "../helpers/userContent";
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

export const listUploads = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const invalidParam: string | undefined = findInvalidUploadListParam(req.query);

        if (invalidParam) {
            return res.status(400).json({ error: Responses.Admin.invalidQuery(invalidParam) });
        }

        const options = toUploadListOptions(req.query);

        const [uploads, total] = await findUploads(
            options,
            options.q ? await findUserIdsByUsernamePart(options.q) : []
        );

        const owners = toUploadOwners(
            await findUsernamesByIds(uploads.map((upload) => upload.uploadedBy))
        );

        return res.status(200).json({
            uploads: uploads.map((upload) => ({
                ...toUploadResponse(upload),
                owner: owners.get(upload.uploadedBy.toString()) ?? null
            })),
            pagination: toUploadPagination(options, total)
        });
    } catch (error) {
        return next(error);
    }
};

export const listShortUrls = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const invalidParam: string | undefined = findInvalidShortUrlListParam(req.query);

        if (invalidParam) {
            return res.status(400).json({ error: Responses.Admin.invalidQuery(invalidParam) });
        }

        const options = toShortUrlListOptions(req.query, 20);

        const [shortUrls, total] = await findShortUrls(options);

        return res.status(200).json({
            shortUrls: shortUrls.map(toAdminShortUrl),
            pagination: toShortUrlPagination(options, total)
        });
    } catch (error) {
        return next(error);
    }
};

export const getMailBudget = (req: express.Request, res: express.Response) =>
    res.status(200).json(readMailBudget());

export const deleteUser = async (
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

        if (isSuperuserEmail(user.email)) {
            return res.status(409).json({ error: Responses.Admin.cannotDeleteSuperuser });
        }

        const userId: string = user._id.toString();

        await removeUserContent(userId);
        await deleteUserById(userId);
        await removeUserContent(userId);

        return res.status(200).json({ message: Responses.Admin.userDeletedSuccess });
    } catch (error) {
        return next(error);
    }
};
