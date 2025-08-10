import express from "express";

import { registerApp, assignLicense, activateLicense } from "../controllers/licensing";
import { isAuthenticated, isSuperUser } from "../middlewares";

export default (router: express.Router) => {
    router.post("/licensing/register", isAuthenticated, registerApp);
    router.post("/licensing/assign/:userId", isAuthenticated, isSuperUser, assignLicense);
    router.post("/licensing/activate", isAuthenticated, activateLicense);
};
