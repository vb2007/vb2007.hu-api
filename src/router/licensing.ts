import express from "express";

import { registerApp, assignLicense } from "../controllers/licensing";
import { isAuthenticated, isSuperUser } from "../middlewares";

export default (router: express.Router) => {
    router.post("/licensing/registerApp", isAuthenticated, registerApp);
    router.post("/licensing/assignLicense", isSuperUser, assignLicense);
};
