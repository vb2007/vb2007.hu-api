import express from "express";

import { redirectToOriginalUrl, shortenUrl } from "../controllers/shortenUrls";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router) => {
    router.get("/r/:shortenedUrl", redirectToOriginalUrl);
    router.post("/shortenUrl/create", isAuthenticated, shortenUrl);
};
