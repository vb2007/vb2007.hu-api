import express from "express";

import { login, register } from "../controllers/authentication";

export default (router: express.Router): void => {
    router.post("/auth/register", register);
    router.post("/auth/login", login);
};
