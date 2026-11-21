import express from "express";

import {
    redirectToOriginalUrl,
    shortenUrl,
    deleteUrl,
    getOriginalUrl,
    listShortUrls
} from "../controllers/shortenUrls";
import { isAuthenticatedWith, isShortUrlOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/r/:shortenedUrl", redirectToOriginalUrl);
    router.get("/shortenUrls", isAuthenticatedWith("shortUrls:read"), listShortUrls);
    router.get("/shortenUrl/:shortenedUrl", getOriginalUrl);
    router.post("/shortenUrl", isAuthenticatedWith("shortUrls:write"), shortenUrl);
    router.delete(
        "/shortenUrl/:shortenedUrl",
        isAuthenticatedWith("shortUrls:write"),
        isShortUrlOwner,
        deleteUrl
    );
};
