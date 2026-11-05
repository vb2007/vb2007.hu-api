import express from "express";

import {
    clearRateLimitLockouts,
    deleteUser,
    getMailBudget,
    getStats,
    listPastes,
    getUserDetailsById,
    listShortUrls,
    listUploads,
    listUserUploads,
    listUsers,
    logoutUser,
    renameUser,
    updateUserSuspension,
    updateUserUploadQuota
} from "../controllers/admin";
import { isAuthenticated, isSuperuser } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/admin/users", isAuthenticated, isSuperuser, listUsers);
    router.get("/admin/users/:id", isAuthenticated, isSuperuser, getUserDetailsById);
    router.patch("/admin/users/:id", isAuthenticated, isSuperuser, renameUser);
    router.patch(
        "/admin/users/:id/upload-quota",
        isAuthenticated,
        isSuperuser,
        updateUserUploadQuota
    );
    router.patch("/admin/users/:id/suspension", isAuthenticated, isSuperuser, updateUserSuspension);
    router.get("/admin/users/:id/uploads", isAuthenticated, isSuperuser, listUserUploads);
    router.get("/admin/uploads", isAuthenticated, isSuperuser, listUploads);
    router.get("/admin/short-urls", isAuthenticated, isSuperuser, listShortUrls);
    router.get("/admin/mail-budget", isAuthenticated, isSuperuser, getMailBudget);
    router.delete("/admin/users/:id", isAuthenticated, isSuperuser, deleteUser);
    router.post("/admin/users/:id/logout", isAuthenticated, isSuperuser, logoutUser);
    router.get("/admin/stats", isAuthenticated, isSuperuser, getStats);
    router.delete("/admin/rate-limits", isAuthenticated, isSuperuser, clearRateLimitLockouts);
    router.get("/admin/pastes", isAuthenticated, isSuperuser, listPastes);
};
