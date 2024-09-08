import express from "express";
import { get, identity, merge } from "lodash";

import { getUserBySessionToken } from "../database/users";

export const isAuthenticated = async(req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
        const sessionToken = req.cookies["VB-AUTH"];

        if (!sessionToken) {
            return res.sendStatus(403);
        }

        const existingUser = await getUserBySessionToken(sessionToken);

        if (!existingUser) {
            return res.sendStatus(403);
        }

        merge(req, { identity: existingUser });

        return next();
    } catch (error) {
        console.error(error);
        return res.sendStatus(400);
    }
}