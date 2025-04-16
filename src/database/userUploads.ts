import mongoose from "mongoose";

const UserUploadsSchema = new mongoose.Schema({
    originalFileName: {
        type: String,
        required: true,
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    uploadedOn: {
        type: Date,
        default: Date.now,
        immutable: true
    }
})