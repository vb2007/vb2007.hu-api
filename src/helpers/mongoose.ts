import express from "express";
import mongoose from "mongoose";

import { Responses } from "../constants/responses";

export const validateMongooseId = (id: string, res: express.Response): boolean => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
            error: Responses.Mongoose.invalidIdFormat
        });
        return false;
    }
    return true;
};

export const validateExistingObject = (
    objectContent: Object,
    objectType: string,
    res: express.Response
) => {
    if (!objectContent) {
        res.status(404).json({
            error: Responses.Mongoose.noSuchObject(objectType)
        });
        return false;
    }
    return true;
};
