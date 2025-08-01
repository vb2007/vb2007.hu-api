import express from "express";

import { registerApp } from "../controllers/licensing";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router) => {
    router.post("/licensing/registerApp", isAuthenticated, registerApp);
};
