import mongoose from "mongoose";

const UserUploadsSchema = new mongoose.Schema({
    originalFileName: {
        type: String,
        required: true
    },
    storedFileName: {
        type: String,
        required: true
    },
    filePath: {
        type: String,
        required: true
    },
    fileSize: {
        type: Number,
        required: true
    },
    mimeType: {
        type: String,
        required: true
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
});

export const UserUploadsModel = mongoose.model("UserUploads", UserUploadsSchema);

export const getUploadDetailsById = (id: string) => UserUploadsModel.findById(id);