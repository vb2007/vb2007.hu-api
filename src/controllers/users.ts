import express from "express";
import fs from "fs";
import path from "path";
import { get } from "lodash";

import { deleteUserById, getUserById, getUserBySessionToken } from "../database/users";
import { deleteUploadsByUser } from "../database/userUploads";
import { Responses } from "../constants/responses";
import { authentication, isSuperuserEmail, random, validatePassword } from "../helpers";
import { startSession } from "../helpers/session";

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

export const changePassword = async (req: express.Request, res: express.Response) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (
            typeof currentPassword !== "string" ||
            typeof newPassword !== "string" ||
            !currentPassword ||
            !newPassword
        ) {
            return res.status(400).json({ error: Responses.Users.missingPasswords });
        }

        const passwordError: string | null = validatePassword(newPassword);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password"
        );

        if (!user.authentication?.password) {
            return res.status(409).json({ error: Responses.Users.noPasswordToChange });
        }

        const expectedHash: string = authentication(user.authentication.salt, currentPassword);

        if (user.authentication.password !== expectedHash) {
            return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
        }

        const salt: string = random();
        user.authentication.salt = salt;
        user.authentication.password = authentication(salt, newPassword);
        await startSession(res, user);

        return res.status(200).json({ message: Responses.Users.passwordChangedSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const deleteUser = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        await fs.promises.rm(path.join(path.resolve(process.env.UPLOAD_DISK_DIRECTORY), id), {
            recursive: true,
            force: true
        });
        await deleteUploadsByUser(id);
        await deleteUserById(id);

        return res.status(200).json({ message: Responses.Users.userDeletedSuccess });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};
