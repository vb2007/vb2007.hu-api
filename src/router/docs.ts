import express from "express";

import { getAdminDocsPage, getAdminSpec, getDocsPage, getPublicSpec } from "../controllers/docs";
import { isAuthenticated, isSuperuser, noStore } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/docs", getDocsPage);
    router.get("/docs/openapi.json", getPublicSpec);
    router.get("/docs/admin", noStore, isAuthenticated, isSuperuser, getAdminDocsPage);
    router.get("/docs/admin/openapi.json", noStore, isAuthenticated, isSuperuser, getAdminSpec);
};
