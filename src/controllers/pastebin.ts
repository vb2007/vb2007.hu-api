import express from "express";

import { createNewPaste, findPastesByUser, deletePasteById } from "../database/pastebin";

export const createPaste = async(req: express.Request, res: express.Response) => {
    try {
        const { paste } = req.body;
        const user = req.identity;

        const response = await createNewPaste({
            paste,
            addedBy: user
        });

        return res.status(200).json(response);
    } catch (error) {
        console.error();
        return res.sendStatus(500);
    }
}

