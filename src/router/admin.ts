import express from "express";

import {
    deleteUser,
    getMailBudget,
    listPastes,
    listUserUploads,
    listUsers,
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
    router.delete("/admin/users/:id", isAuthenticated, isSuperuser, deleteUser);
    router.get("/admin/pastes", isAuthenticated, isSuperuser, listPastes);
};
