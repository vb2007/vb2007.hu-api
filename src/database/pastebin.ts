import mongoose from "mongoose";

export const pasteLanguagePattern: RegExp = /^[a-z0-9+#-]{1,32}$/;
export const pasteMinLength: number = 2;
export const pasteMaxLength: number = 10000;

const PastebinSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true,
        minlength: pasteMinLength,
        maxlength: pasteMaxLength
    },
    language: {
        type: String,
        match: pasteLanguagePattern
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

export const countPastesByUser = (userId: mongoose.Types.ObjectId | string) =>
    PastebinModel.countDocuments({ addedBy: userId }).exec();

export const createNewPaste = (values: Record<string, any>) =>
    new PastebinModel(values).save().then((paste) => paste.toObject());

export const findPasteById = (id: string) => PastebinModel.findById(id);

export const updatePasteById = (id: string, values: { language: string }) =>
    PastebinModel.findByIdAndUpdate(id, values, { new: true, runValidators: true });

export const findPastesByUsername = (
    userId: mongoose.Types.ObjectId | string,
    limit: number = 10,
    page: number = 1,
    sortBy: string = "addedOn",
    sortOrder: "asc" | "desc" = "desc"
) => {
    const skip: number = (page - 1) * limit;
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const sortOptions: any = {};
    sortOptions[sortBy] = sortDirection;

    return PastebinModel.find({ addedBy: userId })
        .sort(sortOptions)
        .limit(limit)
        .skip(skip)
        .populate("addedBy", "username");
};

export const deletePasteById = (id: string) => PastebinModel.findByIdAndDelete(id);

export const deletePastesByUser = (userId: mongoose.Types.ObjectId | string) =>
    PastebinModel.deleteMany({ addedBy: userId });
