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