import express from "express";

import {
    redirectToOriginalUrl,
    shortenUrl,
    deleteUrl,
    getOriginalUrl,
    listShortUrls
} from "../controllers/shortenUrls";
import { isAuthenticated, isShortUrlOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/r/:shortenedUrl", redirectToOriginalUrl);
    router.get("/shortenUrls", isAuthenticated, listShortUrls);
    router.get("/shortenUrl/:shortenedUrl", getOriginalUrl);
    router.post("/shortenUrl", isAuthenticated, shortenUrl);
    router.post("/shortenUrl/create", isAuthenticated, shortenUrl);
    router.delete("/shortenUrl/delete", isAuthenticated, isShortUrlOwner, deleteUrl);
    router.delete("/shortenUrl/:shortenedUrl", isAuthenticated, isShortUrlOwner, deleteUrl);
};
