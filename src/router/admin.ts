import express from "express";

import {
    listPendingRegistrations,
    listUserUploads,
    listUsers,
    removePendingRegistration,
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
    router.get(
        "/admin/pending-registrations",
        isAuthenticated,
        isSuperuser,
        listPendingRegistrations
    );
    router.delete(
        "/admin/pending-registrations/:id",
        isAuthenticated,
        isSuperuser,
        removePendingRegistration
    );
};
