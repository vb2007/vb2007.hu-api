import express from "express";

import { findUsersWithUploadUsage } from "../database/users";
import { Responses } from "../constants/responses";
import { findInvalidUserListParam, toAdminUser, toUserListOptions } from "../helpers/admin";

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
