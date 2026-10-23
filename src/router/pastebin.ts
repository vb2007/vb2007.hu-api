import express from "express";

import {
    createPaste,
    deletePaste,
    findPasteById,
    findPastesByUsername,
    updatePaste
} from "../controllers/pastebin";
import { isAuthenticated, isPasteOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/pastes/:username", isAuthenticated, findPastesByUsername);
    router.get("/paste/:id", findPasteById);
    router.post("/paste", isAuthenticated, createPaste);
    router.patch("/paste/:id", isAuthenticated, isPasteOwner, updatePaste);
    router.delete("/paste/:id", isAuthenticated, isPasteOwner, deletePaste);
};
