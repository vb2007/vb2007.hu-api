import express from "express";

import {
    createPaste,
    deletePaste,
    findPasteById,
    findPastesByUsername,
    updatePaste
} from "../controllers/pastebin";
import { isAuthenticatedWith, isPasteOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/pastes/:username", isAuthenticatedWith("pastes:read"), findPastesByUsername);
    router.get("/paste/:id", findPasteById);
    router.post("/paste", isAuthenticatedWith("pastes:write"), createPaste);
    router.patch("/paste/:id", isAuthenticatedWith("pastes:write"), isPasteOwner, updatePaste);
    router.delete("/paste/:id", isAuthenticatedWith("pastes:write"), isPasteOwner, deletePaste);
};
