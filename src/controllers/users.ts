import express from "express";
import fs from "fs";
import path from "path";
import { get } from "lodash";

import {
    deleteUserById,
    getUserById,
    getUserBySessionToken,
    setPasswordIfUnset
} from "../database/users";
import { deleteUploadsByUser } from "../database/userUploads";
import { Responses } from "../constants/responses";
import { authentication, isSuperuserEmail, random, passwordLengthError } from "../helpers";
import { isDuplicateKeyError } from "../helpers/mongoose";
import { isUsernameTaken, usernameLengthError } from "../helpers/username";

export const getUser = async (req: express.Request, res: express.Response) => {
    try {
        const sessionToken: string = req.cookies["VB-AUTH"];
        const currentUser = await getUserBySessionToken(sessionToken).select(
            "+authentication.password"
        );
        if (!currentUser) {
            return res.status(403).json({ error: Responses.notLoggedIn });
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

        if (typeof username !== "string" || !username) {
            return res.status(400).json({ error: Responses.Users.missingUsername });
        }

        const usernameError: string | null = usernameLengthError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        if (await isUsernameTaken(username, id)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const user = await getUserById(id);

        user.username = username;
        await user.save();

        return res.status(200).json({ message: Responses.Users.userUpdatedSuccess });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        console.error(error);
        return res.sendStatus(500);
    }
};

export const setPassword = async (req: express.Request, res: express.Response) => {
    try {
        const { password } = req.body;

        if (typeof password !== "string" || !password) {
            return res.status(400).json({ error: Responses.Users.missingPassword });
        }

        const passwordError: string | null = passwordLengthError(password);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const salt: string = random();
        const { matchedCount } = await setPasswordIfUnset(
            get(req, "identity._id"),
            salt,
            authentication(salt, password)
        );

        if (matchedCount === 0) {
            return res.status(409).json({ error: Responses.Users.passwordAlreadySet });
        }

        return res.status(200).json({ message: Responses.Users.passwordSetSuccess });
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
