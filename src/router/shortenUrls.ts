import express from "express";

import { redirectToOriginalUrl, shortenUrl, deleteUrl } from "../controllers/shortenUrls";
import { isAuthenticated, isShortUrlOwner } from "../middlewares";

export default (router: express.Router) => {
    router.get("/r/:shortenedUrl", redirectToOriginalUrl);
    router.post("/shortenUrl", isAuthenticated, shortenUrl);
    router.delete("/shortenUrl", isAuthenticated, isShortUrlOwner, deleteUrl);
};
