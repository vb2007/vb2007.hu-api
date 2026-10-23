import express from "express";
import { get } from "lodash";

import {
    PastebinModel,
    findPasteById as findPaste,
    createNewPaste,
    findPastesByUsername as findPastes,
    updatePasteById,
    deletePasteById,
    countPastesByUser,
    pasteLanguagePattern
} from "../database/pastebin";
import { getUserByUsername } from "../database/users";
import { validateMongooseId } from "../helpers/mongoose";
import { Responses } from "../constants/responses";

const isPasteLanguage = (language: unknown): language is string =>
    typeof language === "string" && pasteLanguagePattern.test(language);

export const findPasteById = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;

        if (!validateMongooseId(id, res)) {
            return;
        }

        const paste = await findPaste(id).populate("addedBy", "username");
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
        const { paste, language } = req.body;
        const user = req.identity;

        if (language !== undefined && !isPasteLanguage(language)) {
            return res.status(400).json({ error: Responses.Pastebin.invalidLanguage });
        }

        const response = await createNewPaste({
            content: paste,
            language,
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

export const updatePaste = async (req: express.Request, res: express.Response) => {
    try {
        const { language } = req.body ?? {};

        if (!isPasteLanguage(language)) {
            return res.status(400).json({ error: Responses.Pastebin.invalidLanguage });
        }

        const paste = get(req, "paste") as InstanceType<typeof PastebinModel>;

        const updatedPaste = await updatePasteById(paste._id.toString(), { language });

        return res
            .status(200)
            .json({ message: Responses.Pastebin.pasteUpdatedSuccess, paste: updatedPaste });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const deletePaste = async (req: express.Request, res: express.Response) => {
    try {
        const paste = get(req, "paste") as InstanceType<typeof PastebinModel>;

        await deletePasteById(paste._id.toString());

        return res.status(200).json({
            message: Responses.Pastebin.pasteDeletedSuccess,
            paste: { id: paste._id.toString() }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};

export const findPastesByUsername = async (req: express.Request, res: express.Response) => {
    try {
        const { username } = req.params;
        const limit: number = req.query.limit ? parseInt(req.query.limit as string) : 10;
        const page: number = req.query.page ? parseInt(req.query.page as string) : 1;
        const sortBy: string = (req.query.sortBy as string) || "addedOn";
        const sortOrder: string = (req.query.sortOrder as string) || "desc";

        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: Responses.Pastebin.noSuchUser });
        }

        const pastes = await findPastes(user._id, limit, page, sortBy, sortOrder as "asc" | "desc");

        const total: number = await countPastesByUser(user._id);

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
