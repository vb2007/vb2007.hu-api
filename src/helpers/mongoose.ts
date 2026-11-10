import express from "express";
import mongoose from "mongoose";
import { get, isEmpty } from "lodash";

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

export const isIndexNotFoundError = (error: unknown): boolean =>
    (error as { code?: number })?.code === 27;

export const isDocumentNotFoundError = (error: unknown): boolean =>
    error instanceof mongoose.Error.DocumentNotFoundError;

export const isDuplicateKeyOn = (error: unknown, field: string): boolean =>
    isDuplicateKeyError(error) && Boolean(get(error, ["keyPattern", field]));

export const countMatching = <T>(
    model: mongoose.Model<T>,
    filter: mongoose.FilterQuery<T>
): Promise<number> =>
    isEmpty(filter) ? model.estimatedDocumentCount().exec() : model.countDocuments(filter).exec();
