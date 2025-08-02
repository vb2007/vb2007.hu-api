import express from "express";

import { registerApp, assignLicense, activateLicense } from "../controllers/licensing";
import { isAuthenticated, isSuperUser } from "../middlewares";

export default (router: express.Router) => {
    router.post("/licensing/registerApp", isAuthenticated, registerApp);
    router.post("/licensing/assignLicense", isSuperUser, assignLicense);
    router.post("/licensing/activateLicense", isAuthenticated, activateLicense);
};
