import express from "express";

import {
    getUploadDetails,
    uploadFile,
    deleteUpload,
    findUploadsByUsername
} from "../controllers/userUploads";
import { isAuthenticated } from "../middlewares";

export default (router: express.Router) => {
    router.get("/uploads/:username", isAuthenticated, findUploadsByUsername);
    router.get("/upload/:id", isAuthenticated, getUploadDetails);
    router.post("/upload", isAuthenticated, uploadFile);
    router.delete("/upload/:id", isAuthenticated, deleteUpload);
};
