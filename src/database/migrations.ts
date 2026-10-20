import mongoose from "mongoose";

const MigrationsSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    appliedOn: {
        type: Date,
        default: Date.now,
        required: true
    }
});

export const MigrationsModel = mongoose.model("Migration", MigrationsSchema, "migrations");
