import express from "express";

import {
    checkUploadAccess,
    getUploadDetails,
    getUploadUsage,
    uploadFile,
    updateUpload,
    deleteUpload,
    listUploads
} from "../controllers/userUploads";
import {
    isAuthenticatedWith,
    isUploadOwner,
    handleUpload,
    verifyUploadType,
    checkUploadQuota
} from "../middlewares";

export default (router: express.Router): void => {
    router.get("/uploads/access", checkUploadAccess);
    router.get("/uploads/usage", isAuthenticatedWith("uploads:read"), getUploadUsage);
    router.get("/uploads", isAuthenticatedWith("uploads:read"), listUploads);
    router.get("/upload/:id", isAuthenticatedWith("uploads:read"), isUploadOwner, getUploadDetails);
    router.post(
        "/upload",
        isAuthenticatedWith("uploads:write"),
        handleUpload,
        verifyUploadType,
        checkUploadQuota,
        uploadFile
    );
    router.patch("/upload/:id", isAuthenticatedWith("uploads:write"), isUploadOwner, updateUpload);
    router.delete("/upload/:id", isAuthenticatedWith("uploads:write"), isUploadOwner, deleteUpload);
};
