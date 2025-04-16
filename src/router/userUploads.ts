import express from "express";

import { getUploadDetails, uploadFile } from "../controllers/userUploads";
import { isAuthenticated } from "../middlewares";


export default (router: express.Router) => {
    router.get("/upload/:id", isAuthenticated, getUploadDetails);
    router.post("/upload", isAuthenticated, uploadFile);
}