import express from "express";

import {
    countUsers,
    deleteUserById,
    findUserIdsByUsernamePart,
    findUsernamesByIds,
    findUsersWithUploadUsage,
    getUserById,
    getUserUploadQuota,
    setUserSuspension,
    updateUserById
} from "../database/users";
import {
    findUploads,
    findUploadsByUser,
    getUploadTotalsByVisibility
} from "../database/userUploads";
import { countPastes } from "../database/pastebin";
import { countShortUrls, findShortUrls } from "../database/shortUrls";
import { countPendingRegistrations } from "../database/pendingRegistrations";
import { Responses } from "../constants/responses";
import { isSuperuserEmail } from "../helpers";
import {
    findInvalidUserListParam,
    isUploadQuota,
    toAdminShortUrl,
    toAdminUser,
    toUploadOwners,
    toUploadTotals,
    toUserListOptions
} from "../helpers/admin";
import { readMailBudget } from "../helpers/mail";
import { isDuplicateKeyError, validateMongooseId } from "../helpers/mongoose";
import { maxFileSizeBytes } from "../helpers/multer";
import { revokeSession } from "../helpers/session";
import {
    findInvalidShortUrlListParam,
    toShortUrlListOptions,
    toShortUrlPagination
} from "../helpers/shortUrls";
import { calculateUploadUsage, defaultUploadQuotaBytes } from "../helpers/uploadQuota";
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
            return res.status(400).json({ error: Responses.invalidQuery(invalidParam) });
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

export const updateUserSuspension = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const target = await getUserUploadQuota(id);

        if (!target) {
            return res.status(404).json({ error: Responses.Admin.userNotFound });
        }

        const { suspended } = req.body ?? {};

        if (typeof suspended !== "boolean") {
            return res.status(400).json({ error: Responses.Admin.invalidSuspension });
        }

        if (isSuperuserEmail(target.email)) {
            return res.status(409).json({ error: Responses.Admin.superuserSuspension });
        }

        await setUserSuspension(id, suspended);

        const [user, usage] = await Promise.all([getUserUploadQuota(id), calculateUploadUsage(id)]);

        return res.status(200).json({
            message: suspended
                ? Responses.Admin.userSuspendedSuccess
                : Responses.Admin.userUnsuspendedSuccess,
            user: toAdminUser(user, usage)
        });
    } catch (error) {
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
            return res.status(400).json({ error: Responses.invalidQuery(invalidParam) });
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
            return res.status(400).json({ error: Responses.invalidQuery(invalidParam) });
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
            return res.status(400).json({ error: Responses.invalidQuery(invalidParam) });
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

export const logoutUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const user = await revokeSession(id);

        if (!user) {
            return res.status(404).json({ error: Responses.Admin.userNotFound });
        }

        return res.status(200).json({
            message: Responses.Admin.userLoggedOutSuccess,
            user: { id: user._id.toString(), username: user.username }
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
