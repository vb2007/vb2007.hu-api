import express from "express";

import { createPaste, deletePaste } from "../controllers/pastebin";
import { isAuthenticated } from "middlewares";

export default (router: express.Router) => {
    router.post("/paste", isAuthenticated, createPaste);
    router.delete("/paste", isAuthenticated, deletePaste);
}