import express from "express";

import { Responses } from "../constants/responses";

export const registerApp = async (req: express.Request, res: express.Response) => {
    try {
        const { uniqueAppId } = req.body;
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
