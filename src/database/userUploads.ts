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

export const getUploadById = (id: string) => UserUploadsModel.findById(id);
export const getUploadsByUsername = (userId: mongoose.Types.ObjectId | string, limit: number = 10, page: number = 1, sortBy: string = "addedOn", sortOrder: "asc" | "desc" = "desc") => {
    const skip = (page - 1) * limit;
    const sortDirection = sortOrder === "asc" ? 1 : -1;
    const sortOptions: any = {};
    sortOptions[sortBy] = sortDirection;

    return UserUploadsModel.find({ uploadedBy: userId })
        .sort(sortOptions)
        .limit(limit)
        .skip(skip)
        .populate("uploadedBy", "username");
}
export const deleteUploadById = (id: string) => UserUploadsModel.findByIdAndDelete(id);