import express from "express";

import {
    getAllLicenses,
    getLicense,
    registerApp,
    assignLicense,
    activateLicense
} from "../controllers/licensing";
import { isAuthenticated, isSuperUser } from "../middlewares";

export default (router: express.Router) => {
    router.get("/licensing/licenses", isAuthenticated, isSuperUser, getAllLicenses);
    router.get("/licensing/license", isAuthenticated, getLicense);
    router.post("/licensing/register", isAuthenticated, registerApp);
    router.post("/licensing/assign/:userId", isAuthenticated, isSuperUser, assignLicense);
    router.post("/licensing/activate", isAuthenticated, activateLicense);
};
