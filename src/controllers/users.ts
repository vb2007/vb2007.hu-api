import express from "express";

import { deleteUserById, getUserById, getUserBySessionToken, getUsers } from "../database/users";
import { Responses } from "../constants/responses";

export const getAllUsers = async (req: express.Request, res: express.Response) => {
    try {
        const users = await getUsers();

        return res.status(200).json(users);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const getUser = async (req: express.Request, res: express.Response) => {
    try {
        const sessionToken: string = req.cookies["VB-AUTH"];

        if (!sessionToken) {
            return res.sendStatus(403).json({ error: Responses.notLoggedIn });
        }

        const currentUser = await getUserBySessionToken(sessionToken);
        if (!currentUser) {
            return res.sendStatus(403).json({ error: Responses.notAuthorized });
        }

        return res.status(200).json(currentUser);
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

export const deleteUser = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        await deleteUserById(id);

        return res.status(200).json({ message: Responses.Users.userDeletedSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
