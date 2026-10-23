import express from "express";

import {
    githubCallback,
    githubLink,
    githubLogin,
    login,
    register
} from "../controllers/authentication";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router): void => {
    router.post("/auth/register", register);
    router.post("/auth/login", login);
    router.get("/auth/github", githubLogin);
    router.get("/auth/github/link", isAuthenticated, githubLink);
    router.get("/auth/github/callback", githubCallback);
};
