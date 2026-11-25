import express from "express";

import { getAccountsStatus, introspectApiKey } from "../controllers/oauth";
import { authenticateClient, noStore } from "../middlewares";
import { limitClientChecks, limitAccountStatusRequests } from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.post(
        "/oauth/accounts/status",
        limitClientChecks,
        authenticateClient,
        limitAccountStatusRequests,
        getAccountsStatus
    );
    router.post(
        "/oauth/introspect",
        noStore,
        limitClientChecks,
        authenticateClient,
        introspectApiKey
    );
};
