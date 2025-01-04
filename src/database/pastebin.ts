import mongoose from "mongoose";

const PastebinSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true
    },
    addedBy: {
        type: String,
        required: true,
    },
    addedOn: {
        type: String,
        required: true
    }
});

export const PastebinModel = mongoose.model("Pastebin", PastebinSchema);

export const createNewPaste = (values: Record<string, any>) => new PastebinModel(values)
    .save().then((paste) => paste.toObject());
export const findPastesByUser = (username: string) => PastebinModel.find({ addedBy: username });
export const deletePasteById = (id: string) => PastebinModel.findByIdAndDelete(id);