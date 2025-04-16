import express from "express";

import { uploadFile } from "../controllers/userUploads";
import { isAuthenticated } from "../middlewares";


export default (router: express.Router) => {
    router.post("/upload", isAuthenticated, uploadFile);
}