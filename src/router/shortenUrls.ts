import express from "express";

import { shortenUrl } from "../controllers/shortenUrls";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router) => {
    router.post("/shortenUrl/create", isAuthenticated, shortenUrl);
}