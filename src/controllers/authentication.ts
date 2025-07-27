import express from "express";

import { createUser, getUserByEmail, getUserByUsername } from "../database/users";
import { authentication, random } from "../helpers";

export const login = async (req: express.Request, res: express.Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res
                .status(400)
                .json({ error: "You must provide an E-mail address and a password." });
        }

        const user = await getUserByEmail(email).select(
            "+authentication.salt +authentication.password"
        );

        if (!user) {
            return res
                .status(404)
                .json({ error: "There is no such user with that E-mail address." });
        }

        const exprectedHash = authentication(user.authentication.salt, password);

        if (user.authentication.password !== exprectedHash) {
            return res.status(403).json({ error: "The provided password is incorrect." });
        }

        const salt = random();
        user.authentication.sessionToken = authentication(salt, user._id.toString());

        await user.save();

        res.cookie("VB-AUTH", user.authentication.sessionToken, { domain: "localhost", path: "/" });

        return res
            .status(200)
            .json({ message: `Login successful with user "${user.username}".` })
            .end();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const register = async (req: express.Request, res: express.Response) => {
    try {
        const { username, email, password } = req.body;

        if (!email || !password || !username) {
            return res
                .status(400)
                .json({ error: "You must provide a username, E-mail address, and a password." });
        }

        const existingEmail = await getUserByEmail(email);
        if (existingEmail) {
            return res
                .status(409)
                .json({ error: "An account with this E-mail address already exists." });
        }

        const existingUsername = await getUserByUsername(username);
        if (existingUsername) {
            return res.status(409).json({ error: "This username is already taken." });
        }

        const salt = random();
        const user = await createUser({
            username,
            email,
            authentication: {
                salt,
                password: authentication(salt, password)
            }
        });

        return res
            .status(201)
            .json({ message: `User "${user.username}" registered successfully.` })
            .end();
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
