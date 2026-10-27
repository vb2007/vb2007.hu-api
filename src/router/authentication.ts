import express from "express";

import {
    githubCallback,
    githubLink,
    githubLogin,
    githubUnlink,
    login,
    logout,
    register
} from "../controllers/authentication";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router): void => {
    router.post("/auth/register", register);
    router.post("/auth/login", login);
    router.post("/auth/logout", logout);
    router.get("/auth/github", githubLogin);
    router.get("/auth/github/link", githubLink);
    router.delete("/auth/github/link", isAuthenticated, githubUnlink);
    router.get("/auth/github/callback", githubCallback);
};
