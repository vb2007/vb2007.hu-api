import express from "express";

import { createPaste, deletePaste, findPastesByUsername } from "../controllers/pastebin";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router) => {
    router.post("/paste", isAuthenticated, createPaste);
    router.delete("/paste/:id", isAuthenticated, deletePaste);
    router.get("/pastes/:username", isAuthenticated, findPastesByUsername);
}