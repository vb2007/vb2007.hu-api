import express from "express";

import {
    createPaste,
    deletePaste,
    findPasteById,
    findPastesByUsername
} from "../controllers/pastebin";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router) => {
    router.get("/pastes/:username", isAuthenticated, findPastesByUsername);
    router.get("/paste/:id", findPasteById);
    router.post("/paste", isAuthenticated, createPaste);
    router.delete("/paste/:id", isAuthenticated, deletePaste);
};
