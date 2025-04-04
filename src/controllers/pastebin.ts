import express from "express";

import { createNewPaste, findPastesByUsername, deletePasteById } from "../database/pastebin";

export const createPaste = async(req: express.Request, res: express.Response) => {
    try {
        const { paste } = req.body;
        const user = req.identity;

        const response = await createNewPaste({
            content: paste,
            addedBy: user.username
        });

        return res.status(200).json(response);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const deletePaste = async(req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        const deletedPaste = await deletePasteById(id);

        return res.json(deletedPaste);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const findPastesByUsername = async(req: express.Request, res: express.Response) => {
    try {
        const { username } = req.params;
        
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}