import express from "express";

import { findPasteById as findPaste, createNewPaste, findPastesByUsername as findPastes, deletePasteById, PastebinModel } from "../database/pastebin";
import { getUserByUsername } from "../database/users";
import { validateMongooseId, validateExistingObject } from "../helpers/mongoose";

export const findPasteById = async(req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const paste = await findPaste(id);

        if (!validateExistingObject(paste, "paste", res)) {
            return;
        }

        return res.status(200).json({ paste });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const createPaste = async(req: express.Request, res: express.Response) => {
    try {
        const { paste } = req.body;
        const user = req.identity;

        const response = await createNewPaste({
            content: paste,
            addedBy: user._id
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

        if (!validateMongooseId(id, res)) {
            return;
        }

        const paste = await findPaste(id);
        
        if (!validateExistingObject(paste, "paste", res)) {
            return;
        }

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
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
        const page = req.query.page ? parseInt(req.query.page as string) : 1;
        const sortBy = (req.query.sortBy as string) || "addedOn";
        const sortOrder = (req.query.sortOrder as string) || "desc";

        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const pastes = await findPastes(
            user._id,
            limit,
            page,
            sortBy,
            sortOrder as "asc" | "desc"
        );

        const total = await PastebinModel.countDocuments({ addedBy: user._id });

        return res.status(200).json({
            pastes,
            pagination: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}