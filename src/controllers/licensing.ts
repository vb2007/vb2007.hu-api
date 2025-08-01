import express from "express";

import { registerApp as registerAppDB } from "../database/licensing";
import { Responses } from "../constants/responses";

export const registerApp = async (req: express.Request, res: express.Response) => {
    try {
        const { uniqueAppId } = req.body;
        const user = req.identity;

        const response = await registerAppDB({
            uniqueAppId: uniqueAppId,
            userId: user._id
        });

        if (!response) {
            return res.status(409).json({ error: Responses.Licensing.appAlreadyRegistered });
        }
        return res
            .status(201)
            .json({ message: Responses.Licensing.appAlreadyRegistered, data: response });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
