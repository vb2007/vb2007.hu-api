import express from "express";

import { listUserUploads, listUsers } from "../controllers/admin";
import { isAuthenticated, isSuperuser } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/admin/users", isAuthenticated, isSuperuser, listUsers);
    router.get("/admin/users/:id/uploads", isAuthenticated, isSuperuser, listUserUploads);
};
