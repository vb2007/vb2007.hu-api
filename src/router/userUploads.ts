import express from "express";

import {
    getUploadDetails,
    uploadFile,
    deleteUpload,
    findUploadsByUsername
} from "../controllers/userUploads";
import { isAuthenticated, isUploadOwner } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/uploads/:username", isAuthenticated, findUploadsByUsername);
    router.get("/upload/:id", isAuthenticated, isUploadOwner, getUploadDetails);
    router.post("/upload", isAuthenticated, uploadFile);
    router.delete("/upload/:id", isAuthenticated, isUploadOwner, deleteUpload);
};
