import express from "express";

import {
    findPasteById as findPaste,
    createNewPaste,
    findPastesByUsername as findPastes,
    deletePasteById,
    countPastesByUser
} from "../database/pastebin";
import { getUserByUsername } from "../database/users";
import { validateMongooseId } from "../helpers/mongoose";
import { Responses } from "../constants/responses";

export const findPasteById = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const paste = await findPaste(id);
        if (!paste) {
            return res.status(404).json({ error: Responses.Pastebin.pasteNotFound });
        }

        return res.status(200).json({ paste });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const createPaste = async (req: express.Request, res: express.Response) => {
    try {
        const { paste } = req.body;
        const user = req.identity;

        const response = await createNewPaste({
            content: paste,
            addedBy: user._id
        });

        return res
            .status(201)
            .json({ message: Responses.Pastebin.pasteCreatedSuccess, paste: response });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const deletePaste = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const paste = await findPaste(id);
        if (!paste) {
            return res.status(404).json({ error: Responses.Pastebin.pasteNotFound });
        }

        const deletedPaste = await deletePasteById(id);

        return res
            .status(200)
            .json({ message: Responses.Pastebin.pasteDeletedSuccess, paste: deletedPaste });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const findPastesByUsername = async (req: express.Request, res: express.Response) => {
    try {
        const { username } = req.params;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
        const page = req.query.page ? parseInt(req.query.page as string) : 1;
        const sortBy = (req.query.sortBy as string) || "addedOn";
        const sortOrder = (req.query.sortOrder as string) || "desc";

        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: Responses.Pastebin.noSuchUser });
        }

        const pastes = await findPastes(user._id, limit, page, sortBy, sortOrder as "asc" | "desc");

        const total = await countPastesByUser(user._id);

        return res.status(200).json({
            pastes,
            pagination: {
                limit,
                page,
                total,
                pages: Math.ceil(total / limit),
                sortBy,
                sortOrder
            }
        });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};
