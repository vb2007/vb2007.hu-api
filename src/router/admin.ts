import express from "express";

import {
    getMailBudget,
    listUserUploads,
    listUsers,
    logoutUser,
    renameUser,
    updateUserUploadQuota
} from "../controllers/admin";
import { isAuthenticated, isSuperuser } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/admin/users", isAuthenticated, isSuperuser, listUsers);
    router.patch("/admin/users/:id", isAuthenticated, isSuperuser, renameUser);
    router.patch(
        "/admin/users/:id/upload-quota",
        isAuthenticated,
        isSuperuser,
        updateUserUploadQuota
    );
    router.get("/admin/users/:id/uploads", isAuthenticated, isSuperuser, listUserUploads);
    router.get("/admin/mail-budget", isAuthenticated, isSuperuser, getMailBudget);
    router.post("/admin/users/:id/logout", isAuthenticated, isSuperuser, logoutUser);
};
