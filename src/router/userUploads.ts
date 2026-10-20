import express from "express";

import {
    getUploadDetails,
    uploadFile,
    updateUpload,
    deleteUpload,
    listUploads
} from "../controllers/userUploads";
import { isAuthenticated, isUploadOwner, handleUpload, verifyUploadType } from "../middlewares";

export default (router: express.Router): void => {
    router.get("/uploads", isAuthenticated, listUploads);
    router.get("/upload/:id", isAuthenticated, isUploadOwner, getUploadDetails);
    router.post("/upload", isAuthenticated, handleUpload, verifyUploadType, uploadFile);
    router.patch("/upload/:id", isAuthenticated, isUploadOwner, updateUpload);
    router.delete("/upload/:id", isAuthenticated, isUploadOwner, deleteUpload);
};
