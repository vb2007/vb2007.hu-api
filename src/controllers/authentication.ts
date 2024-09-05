import express from "express";

import { createUser, getUserByEmail } from "database/users";
import { authentication, random } from "helpers";

export const register = async (req: express.Request, res: express.Response) => {
    try {
        //data expected from the body
        const { username, email, password } = req.body;

        if (!email || !password || !username) {
            return res.status(400);
        }
        
        const existingUser = await getUserByEmail(email);
        if (existingUser) {
            return res.status(400);
        }

        const salt = random();
        const user = await createUser({
            username,
            email,
            authentication: {
                salt,
                password: authentication(salt, password),
            },
        });

        return res.status(200).json(user).end();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}