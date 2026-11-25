import express from "express";

import { getAccountsStatus, introspectApiKey } from "../controllers/oauth";
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
    limitAccountStatusRequests
} from "../middlewares/rateLimit";

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
    router.get("/oauth/clients/:clientId", getOauthClient);
    router.get("/oauth/authorize", startAuthorization);
    router.post("/oauth/authorize", noStore, isAuthenticated, limitAuthorizations, authorize);
    router.post(
        "/oauth/token",
        noStore,
        parseFormBody,
        limitClientChecks,
        authenticateClient,
        exchangeCode
    );
};
