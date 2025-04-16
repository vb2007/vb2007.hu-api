import express from "express";
import multer, { Multer } from "multer";
import path from "path";
import fs from "fs";
import { get } from "lodash";

import { getUploadDetailsById } from "../database/userUploads";

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, "../../uploads");

        //creates upload directory if it doesn't exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        cb(null, uploadDir)
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + " - " + Math.round(Math.random() * 1E9);
        const fileExt = path.extname(file.originalname);
        cb(null, uniqueSuffix + fileExt);
    }
});

//accepts all files for now, this will later be used for filtering
const fileFilter = (req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    cb(null, true)
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, //5 MB upload limit, this will later be configurable from the .env file
    }
});

export const uploadFile = async(req: express.Request, res: express.Response) => {
    try {
        
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}

export const getUploadDetails = async(req: express.Request, res: express.Response) => {
    try {
        
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
}