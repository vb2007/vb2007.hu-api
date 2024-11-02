import express from "express";

import { createPaste, findPastesByUser, deletePaste } from "../database/pastebin";

export const addPaste = async(req: express.Request, res: express.Response) => {
    try {
        const { paste } = req.body;
        const user = req.identity;

        const response = await createPaste({
            paste,
            addedBy: user
        });

        return res.status(200).json(response);
    } catch (error) {
        console.error();
        return res.sendStatus(500);
    }
}