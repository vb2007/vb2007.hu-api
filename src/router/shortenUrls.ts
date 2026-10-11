import express from "express";

import {
    redirectToOriginalUrl,
    shortenUrl,
    deleteUrl,
    getOriginalUrl
} from "../controllers/shortenUrls";
import { isAuthenticated, isShortUrlOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/r/:shortenedUrl", redirectToOriginalUrl);
    router.get("/shortenUrl/:shortenedUrl", getOriginalUrl);
    router.post("/shortenUrl/create", isAuthenticated, shortenUrl);
    router.delete("/shortenUrl/delete", isAuthenticated, isShortUrlOwner, deleteUrl);
};
