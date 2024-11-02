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