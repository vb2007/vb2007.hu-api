import express from "express";

import { createUser, getUserByEmail, getUserByUsername } from "../database/users";
import { authentication, random } from "../helpers";
import { Responses } from "../constants/responses";

export const login = async (req: express.Request, res: express.Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: Responses.Authentication.missingEmailPassword });
        }

        const user = await getUserByEmail(email).select(
            "+authentication.salt +authentication.password"
        );

        if (!user) {
            return res.status(404).json({ error: Responses.Authentication.userNotFound });
        }

        const exprectedHash = authentication(user.authentication.salt, password);

        if (user.authentication.password !== exprectedHash) {
            return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
        }

        const salt = random();
        user.authentication.sessionToken = authentication(salt, user._id.toString());

        await user.save();

        const isProduction = process.env.NODE_ENV === "production";
        const cookieDomain = process.env.COOKIE_DOMAIN?.trim() || req.hostname; // fallback to current host

        res.cookie("VB-AUTH", user.authentication.sessionToken, {
            domain: cookieDomain,
            path: "/",
            httpOnly: true,
            secure: isProduction, // required for SameSite=None
            sameSite: isProduction ? "none" : "lax",
            maxAge: 1000 * 60 * 60 * 24 * 30 // =30 days
        });

        return res
            .status(200)
            .json({ message: Responses.Authentication.loginSuccess(user.username) });
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
                .json({ error: Responses.Authentication.missingEmailPasswordUsername });
        }

        const existingEmail = await getUserByEmail(email);
        if (existingEmail) {
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        const existingUsername = await getUserByUsername(username);
        if (existingUsername) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
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
            .json({ message: Responses.Authentication.registrationSuccess(user.username) });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
