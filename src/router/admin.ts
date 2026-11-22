import express from "express";

import {
    clearRateLimitLockouts,
    deleteUser,
    getMailBudget,
    getStats,
    getUserDetailsById,
    listPastes,
    listPendingRegistrations,
    listShortUrls,
    listUploads,
    listUserUploads,
    listUsers,
    logoutUser,
    removePendingRegistration,
    renameUser,
    resetUserMfa,
    revokeUserApiKeys,
    updateUserSuspension,
    updateUserUploadQuota
} from "../controllers/admin";
import { isAuthenticated, isAuthenticatedWith, isSuperuser } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/admin/users", isAuthenticatedWith("admin:read"), isSuperuser, listUsers);
    router.get(
        "/admin/users/:id",
        isAuthenticatedWith("admin:read"),
        isSuperuser,
        getUserDetailsById
    );
    router.patch("/admin/users/:id", isAuthenticatedWith("admin:write"), isSuperuser, renameUser);
    router.patch(
        "/admin/users/:id/upload-quota",
        isAuthenticatedWith("admin:write"),
        isSuperuser,
        updateUserUploadQuota
    );
    router.patch(
        "/admin/users/:id/suspension",
        isAuthenticatedWith("admin:write"),
        isSuperuser,
        updateUserSuspension
    );
    router.get(
        "/admin/users/:id/uploads",
        isAuthenticatedWith("admin:read"),
        isSuperuser,
        listUserUploads
    );
    router.get("/admin/uploads", isAuthenticatedWith("admin:read"), isSuperuser, listUploads);
    router.get("/admin/short-urls", isAuthenticatedWith("admin:read"), isSuperuser, listShortUrls);
    router.get("/admin/mail-budget", isAuthenticatedWith("admin:read"), isSuperuser, getMailBudget);
    router.delete("/admin/users/:id", isAuthenticatedWith("admin:write"), isSuperuser, deleteUser);
    router.post(
        "/admin/users/:id/logout",
        isAuthenticatedWith("admin:write"),
        isSuperuser,
        logoutUser
    );
    router.delete(
        "/admin/users/:id/mfa",
        isAuthenticatedWith("admin:write"),
        isSuperuser,
        resetUserMfa
    );
    router.delete(
        "/admin/users/:id/api-keys",
        isAuthenticatedWith("admin:write"),
        isSuperuser,
        revokeUserApiKeys
    );
    router.get("/admin/stats", isAuthenticatedWith("admin:read"), isSuperuser, getStats);
    router.delete("/admin/rate-limits", isAuthenticated, isSuperuser, clearRateLimitLockouts);
    router.get("/admin/pastes", isAuthenticatedWith("admin:read"), isSuperuser, listPastes);
    router.get(
        "/admin/pending-registrations",
        isAuthenticatedWith("admin:read"),
        isSuperuser,
        listPendingRegistrations
    );
    router.delete(
        "/admin/pending-registrations/:id",
        isAuthenticatedWith("admin:write"),
        isSuperuser,
        removePendingRegistration
    );
};
