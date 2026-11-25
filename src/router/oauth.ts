import express from "express";

import { getAccountsStatus } from "../controllers/oauth";
import { authenticateClient } from "../middlewares";
import { limitClientChecks, limitClientRequests } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.post(
        "/oauth/accounts/status",
        limitClientChecks,
        authenticateClient,
        limitClientRequests,
        getAccountsStatus
    );
};
