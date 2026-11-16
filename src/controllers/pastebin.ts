import express from "express";
import { get } from "lodash";

import {
    Paste,
    findPasteWithOwner,
    createNewPaste,
    findPastesByUsername as findPastes,
    updatePasteById,
    deletePasteById,
    countPastesByUser,
    pasteLanguagePattern
} from "../database/pastebin";
import { getUserById, getUserByUsername } from "../database/users";
import { validateObjectId } from "../helpers/prisma";
import {
    findInvalidPasteListParam,
    toPasteListOptions,
    toPasteOwner,
    toPastePagination,
    toPasteResponse
} from "../helpers/pastebin";
import { PASTE_MAX_LENGTH, PASTE_MIN_LENGTH } from "../constants/limits";
import { Responses } from "../constants/responses";

const isPasteLanguage = (language: unknown): language is string =>
    typeof language === "string" && pasteLanguagePattern.test(language);

export const findPasteById = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;

        if (!validateObjectId(id, res)) {
            return;
        }

        const paste = await findPasteWithOwner(id);
        if (!paste) {
            return res.status(404).json({ error: Responses.Pastebin.pasteNotFound });
        }

        return res.status(200).json({ paste: toPasteResponse(paste, toPasteOwner(paste.owner)) });
    } catch (error) {
        return next(error);
    }
};

export const createPaste = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { paste, language } = req.body ?? {};
        const user = req.identity;

        if (typeof paste !== "string" || !paste) {
            return res.status(400).json({ error: Responses.Pastebin.missingPaste });
        }

        if (paste.length < PASTE_MIN_LENGTH || paste.length > PASTE_MAX_LENGTH) {
            return res.status(400).json({ error: Responses.Pastebin.invalidPasteLength });
        }

        if (language !== undefined && !isPasteLanguage(language)) {
            return res.status(400).json({ error: Responses.Pastebin.invalidLanguage });
        }

        const response = await createNewPaste({
            content: paste,
            language,
            addedBy: user._id
        });

        if (!(await getUserById(user._id.toString()))) {
            await deletePasteById(response.id);
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res.status(201).json({
            message: Responses.Pastebin.pasteCreatedSuccess,
            paste: toPasteResponse(response, response.addedBy)
        });
    } catch (error) {
        return next(error);
    }
};

export const updatePaste = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { language } = req.body ?? {};

        if (!isPasteLanguage(language)) {
            return res.status(400).json({ error: Responses.Pastebin.invalidLanguage });
        }

        const paste = get(req, "paste") as Paste;

        const updatedPaste = await updatePasteById(paste.id, { language });

        return res.status(200).json({
            message: Responses.Pastebin.pasteUpdatedSuccess,
            paste: updatedPaste && toPasteResponse(updatedPaste, updatedPaste.addedBy)
        });
    } catch (error) {
        return next(error);
    }
};

export const deletePaste = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const paste = get(req, "paste") as Paste;

        await deletePasteById(paste.id);

        return res.status(200).json({
            message: Responses.Pastebin.pasteDeletedSuccess,
            paste: { id: paste.id }
        });
    } catch (error) {
        return next(error);
    }
};

export const findPastesByUsername = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const invalidParam: string | undefined = findInvalidPasteListParam(req.query);

        if (invalidParam) {
            return res.status(400).json({ error: Responses.invalidQuery(invalidParam) });
        }

        const { username } = req.params;
        const options = toPasteListOptions(req.query);

        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: Responses.Pastebin.noSuchUser });
        }

        const pastes = await findPastes(user._id, options);

        const total: number = await countPastesByUser(user._id);

        return res.status(200).json({
            pastes: pastes.map((paste) => toPasteResponse(paste, toPasteOwner(paste.owner))),
            pagination: toPastePagination(options, total)
        });
    } catch (error) {
        return next(error);
    }
};
