import express from "express";
import fs from "fs";
import path from "path";

import { deleteUserById, getUserById, getUserBySessionToken } from "../database/users";
import { deleteUploadsByUser } from "../database/userUploads";
import { Responses } from "../constants/responses";
import { isSuperuserEmail } from "../helpers";

export const getUser = async (req: express.Request, res: express.Response) => {
    try {
        const sessionToken: string = req.cookies["VB-AUTH"];

        if (!sessionToken) {
            return res.sendStatus(403).json({ error: Responses.notLoggedIn });
        }

        const currentUser = await getUserBySessionToken(sessionToken).select(
            "+authentication.password"
        );
        if (!currentUser) {
            return res.sendStatus(403).json({ error: Responses.notAuthorized });
        }

        const { authentication, ...user } = currentUser.toObject();

        return res.status(200).json({
            ...user,
            hasPassword: Boolean(authentication?.password),
            isSuperuser: isSuperuserEmail(currentUser.email)
        });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const updateUser = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const { username } = req.body;

        if (!username) {
            return res.sendStatus(400);
        }

        const user = await getUserById(id);

        user.username = username;
        await user.save();

        return res.status(200).json({ message: Responses.Users.userUpdatedSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

const removeUserUploads = async (id: string): Promise<void> => {
    await deleteUploadsByUser(id);
    await fs.promises.rm(path.join(path.resolve(process.env.UPLOAD_DISK_DIRECTORY), id), {
        recursive: true,
        force: true,
        maxRetries: 3
    });
};

export const deleteUser = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        await removeUserUploads(id);
        await deleteUserById(id);
        await removeUserUploads(id);

        return res.status(200).json({ message: Responses.Users.userDeletedSuccess });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};
