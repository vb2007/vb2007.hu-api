import express from "express";

import { getAccountsStatus } from "../controllers/oauth";
import {
    authorize,
    exchangeCode,
    getOauthClient,
    startAuthorization
} from "../controllers/oauthAuthorize";
import { authenticateClient, isAuthenticated, noStore, parseFormBody } from "../middlewares";
import {
    limitAuthorizations,
    limitClientChecks,
    limitAccountStatusRequests,
    limitTokenExchanges
} from "../middlewares/rateLimit";

export default (router: express.Router): void => {
    router.post(
        "/oauth/accounts/status",
        limitClientChecks,
        authenticateClient,
        limitAccountStatusRequests,
        getAccountsStatus
    );
    router.get("/oauth/clients/:clientId", getOauthClient);
    router.get("/oauth/authorize", startAuthorization);
    router.post("/oauth/authorize", noStore, isAuthenticated, limitAuthorizations, authorize);
    router.post(
        "/oauth/token",
        noStore,
        parseFormBody,
        limitClientChecks,
        authenticateClient,
        limitTokenExchanges,
        exchangeCode
    );
};
