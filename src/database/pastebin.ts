import mongoose from "mongoose";

const PastebinSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true,
        minlength: 2,
        maxlength: 10000
    },
    addedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    addedOn: {
        type: Date,
        default: Date.now,
        required: true
    }
});

export const PastebinModel = mongoose.model("Pastebin", PastebinSchema);

export const createNewPaste = (values: Record<string, any>) =>
    new PastebinModel(values).save().then((paste) => paste.toObject());
export const findPasteById = (id: string) => PastebinModel.findById(id);
export const findPastesByUsername = (
    userId: mongoose.Types.ObjectId | string,
    limit: number = 10,
    page: number = 1,
    sortBy: string = "addedOn",
    sortOrder: "asc" | "desc" = "desc"
) => {
    const skip = (page - 1) * limit;
    const sortDirection = sortOrder === "asc" ? 1 : -1;
    const sortOptions: any = {};
    sortOptions[sortBy] = sortDirection;

    return PastebinModel.find({ addedBy: userId })
        .sort(sortOptions)
        .limit(limit)
        .skip(skip)
        .populate("addedBy", "username");
};
export const deletePasteById = (id: string) => PastebinModel.findByIdAndDelete(id);
