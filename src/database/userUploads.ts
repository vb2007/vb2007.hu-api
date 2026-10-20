import mongoose from "mongoose";

export const uploadVisibilities = ["public", "private"] as const;

export type UploadVisibility = (typeof uploadVisibilities)[number];

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
    extension: {
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
    visibility: {
        type: String,
        enum: uploadVisibilities,
        default: "private",
        index: true
    },
    uploadedOn: {
        type: Date,
        default: Date.now,
        immutable: true
    },
    updatedOn: {
        type: Date,
        default: Date.now
    }
});

UserUploadsSchema.index({ uploadedBy: 1, uploadedOn: -1 });

export const UserUploadsModel = mongoose.model("UserUploads", UserUploadsSchema);

export const getUploadById = (id: string) => UserUploadsModel.findById(id);

export const createUserUpload = (values: {
    _id: mongoose.Types.ObjectId;
    originalFileName: string;
    uploadedBy: mongoose.Types.ObjectId | string;
    storedFileName: string;
    filePath: string;
    extension: string;
    fileSize: number;
    mimeType: string;
    visibility: UploadVisibility;
}) => new UserUploadsModel(values).save().then((upload) => upload.toObject());

export const updateUploadById = (
    id: string,
    values: { originalFileName?: string; visibility?: UploadVisibility; updatedOn: Date }
) => UserUploadsModel.findByIdAndUpdate(id, values, { new: true });

export const deleteUploadById = (id: string) => UserUploadsModel.findByIdAndDelete(id);
