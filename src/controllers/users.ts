import express from "express";
import fs from "fs";
import path from "path";
import { get } from "lodash";

import {
    deleteUserById,
    getUserByEmail,
    getUserById,
    getUserBySessionToken
} from "../database/users";
import { deleteUploadsByUser } from "../database/userUploads";
import { Responses } from "../constants/responses";
import { authentication, isSuperuserEmail, isValidEmail, normalizeEmail } from "../helpers";

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

export const changeEmail = async (req: express.Request, res: express.Response) => {
    try {
        const { email, password } = req.body;

        if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
            return res.status(400).json({ error: Responses.Authentication.missingEmailPassword });
        }

        const normalizedEmail: string = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json({ error: Responses.Authentication.invalidEmailFormat });
        }

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password"
        );

        if (isSuperuserEmail(user.email)) {
            return res.status(403).json({ error: Responses.Users.superuserEmailChange });
        }

        if (!user.authentication?.password) {
            return res.status(409).json({ error: Responses.Users.noPasswordToChangeEmail });
        }

        if (user.authentication.password !== authentication(user.authentication.salt, password)) {
            return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
        }

        if (isSuperuserEmail(normalizedEmail)) {
            return res.status(403).json({ error: Responses.Users.emailReservedForSuperuser });
        }

        const existingUser = await getUserByEmail(normalizedEmail);
        if (existingUser && !existingUser._id.equals(user._id)) {
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        user.email = normalizedEmail;
        await user.save();

        return res.status(200).json({ message: Responses.Users.emailUpdatedSuccess });
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
