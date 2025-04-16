import express from "express";
import { get } from "lodash";

import { getUploadDetailsById } from "../database/userUploads";

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