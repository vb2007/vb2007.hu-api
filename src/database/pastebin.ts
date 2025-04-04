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

export const createNewPaste = (values: Record<string, any>) => new PastebinModel(values)
    .save().then((paste) => paste.toObject());
export const findPastesByUsername = (username: string) => PastebinModel.find({ addedBy: username });
export const deletePasteById = (id: string) => PastebinModel.findByIdAndDelete(id);