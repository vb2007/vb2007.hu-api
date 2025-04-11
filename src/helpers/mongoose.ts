import express from "express";
import mongoose from "mongoose";

export const validateMongooseId = (id: string, res: express.Response): boolean => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
            error: "Invalid ID format: must be a 24 character HEX string."
        });
        return false;
    }
    return true;
}

export const validateExistingObject = (objectContent: Object, objectType: string, res: express.Response) => {
    if (!objectContent) {
        res.status(404).json({
            error: `There is no such ${objectType} with that ID in the database.`
        });
        return false;
    }
    return true;
}