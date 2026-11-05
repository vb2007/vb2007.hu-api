import express from "express";

import {
    listShortUrls,
    listUserUploads,
    listUsers,
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
    router.get("/admin/users/:id/uploads", isAuthenticated, isSuperuser, listUserUploads);
    router.get("/admin/short-urls", isAuthenticated, isSuperuser, listShortUrls);
};
