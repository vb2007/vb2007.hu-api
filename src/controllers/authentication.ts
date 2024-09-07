import express, { response } from "express";

import { createUser, getUserByEmail } from "../database/users";
import { authentication, random } from "../helpers";
import cookieParser from "cookie-parser";

export const login = async(req: express.Request, res: express.Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.sendStatus(400);
        }

        const user = await getUserByEmail(email).select("+authentication.salt +authentication.password");

        if (!user) {
            return res.sendStatus(400);
        }

        const exprectedHash = authentication(user.authentication.salt, password);

        if (user.authentication.password !== exprectedHash) {
            return res.sendStatus(403);
        }

        const salt = random()
        user.authentication.sessionToken = authentication(salt, user._id.toString());

        await user.save();

        res.cookie('VB-AUTH', user.authentication.sessionToken, { domain: 'localhost', path: "/" });

        return res.status(200).json(user).end();

    } catch (error) {
        console.error(error);
        return res.sendStatus(400);
    }
}

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