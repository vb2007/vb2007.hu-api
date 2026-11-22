import express from "express";

import {
    createApiKey,
    deleteApiKeyById,
    listApiKeys,
    rotateApiKeyById
} from "../controllers/apiKeys";
import { isAuthenticated } from "../middlewares";
import { limitPasswordChecks } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.get("/user/api-keys", isAuthenticated, listApiKeys);
    router.post("/user/api-keys", isAuthenticated, limitPasswordChecks, createApiKey);
    router.post(
        "/user/api-keys/:id/rotate",
        isAuthenticated,
        limitPasswordChecks,
        rotateApiKeyById
    );
    router.delete("/user/api-keys/:id", isAuthenticated, deleteApiKeyById);
};
