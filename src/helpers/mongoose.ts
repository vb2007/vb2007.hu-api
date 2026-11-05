import express from "express";
import mongoose from "mongoose";
import { get } from "lodash";

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

export const isDuplicateKeyError = (error: unknown): boolean =>
    (error as { code?: number })?.code === 11000;

export const isDuplicateKeyOn = (error: unknown, field: string): boolean =>
    isDuplicateKeyError(error) && Boolean(get(error, ["keyPattern", field]));
