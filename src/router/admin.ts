import express from "express";

import {
    listUserUploads,
    listUsers,
    updateUserSuspension,
    updateUserUploadQuota
} from "../controllers/admin";
import { isAuthenticated, isSuperuser } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/admin/users", isAuthenticated, isSuperuser, listUsers);
    router.patch(
        "/admin/users/:id/upload-quota",
        isAuthenticated,
        isSuperuser,
        updateUserUploadQuota
    );
    router.patch("/admin/users/:id/suspension", isAuthenticated, isSuperuser, updateUserSuspension);
    router.get("/admin/users/:id/uploads", isAuthenticated, isSuperuser, listUserUploads);
};
