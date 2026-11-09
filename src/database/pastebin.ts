import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { SortOrder } from "./userUploads";
import { UserModel, findUserIdsByUsernamePart } from "./users";
import { countMatching } from "../helpers/mongoose";
import {
    PASTE_LANGUAGE_MAX_LENGTH,
    PASTE_LANGUAGE_MIN_LENGTH,
    PASTE_MAX_LENGTH,
    PASTE_MIN_LENGTH,
    PASTE_PREVIEW_LENGTH
} from "../constants/limits";

export const pasteLanguagePattern: RegExp = new RegExp(
    `^[a-z0-9+#-]{${PASTE_LANGUAGE_MIN_LENGTH},${PASTE_LANGUAGE_MAX_LENGTH}}$`
);

export const pasteSortFields = ["addedOn"] as const;

export type PasteSortField = (typeof pasteSortFields)[number];

export interface PasteListOptions {
    limit: number;
    page: number;
    sortBy: PasteSortField;
    sortOrder: SortOrder;
}

export interface AdminPasteListOptions extends PasteListOptions {
    q?: string;
}

export interface PasteWithOwner {
    _id: mongoose.Types.ObjectId;
    language?: string;
    preview: string;
    addedOn: Date;
    owner?: { _id: mongoose.Types.ObjectId; username: string };
}

const PastebinSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true,
        minlength: PASTE_MIN_LENGTH,
        maxlength: PASTE_MAX_LENGTH
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

PastebinSchema.index({ addedOn: -1, _id: -1 });

PastebinSchema.set("toJSON", { versionKey: false });
PastebinSchema.set("toObject", { versionKey: false });

export const PastebinModel = mongoose.model("Pastebin", PastebinSchema);

export const countPastesByUser = (userId: mongoose.Types.ObjectId | string) =>
    PastebinModel.countDocuments({ addedBy: userId }).exec();

export const countPastes = () => PastebinModel.countDocuments().exec();

export const createNewPaste = (values: Record<string, any>) =>
    new PastebinModel(values).save().then((paste) => paste.toObject());

export const findPasteById = (id: string) => PastebinModel.findById(id);

export const updatePasteById = (id: string, values: { language: string }) =>
    PastebinModel.findByIdAndUpdate(id, values, { new: true, runValidators: true });

export const findPastesByUsername = (
    userId: mongoose.Types.ObjectId | string,
    { limit, page, sortBy, sortOrder }: PasteListOptions
) => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;

    return PastebinModel.find({ addedBy: userId })
        .sort({ [sortBy]: sortDirection, _id: sortDirection })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("addedBy", "username");
};

export const deletePasteById = (id: string) => PastebinModel.findByIdAndDelete(id);

export const deletePastesByUser = (userId: mongoose.Types.ObjectId | string) =>
    PastebinModel.deleteMany({ addedBy: userId });

const pasteOwnerStages: mongoose.PipelineStage[] = [
    {
        $lookup: {
            from: UserModel.collection.name,
            let: { ownerId: "$addedBy" },
            pipeline: [
                { $match: { $expr: { $eq: ["$_id", "$$ownerId"] } } },
                { $project: { _id: 1, username: 1 } }
            ],
            as: "owner"
        }
    },
    { $set: { owner: { $arrayElemAt: ["$owner", 0] } } }
];

const pasteSearchFilter = async (q: string): Promise<mongoose.FilterQuery<unknown>> => ({
    $or: [
        { addedBy: { $in: await findUserIdsByUsernamePart(q) } },
        { language: { $regex: escapeRegExp(q), $options: "i" } }
    ]
});

export const findPastesWithOwners = async ({
    limit,
    page,
    sortBy,
    sortOrder,
    q
}: AdminPasteListOptions): Promise<[PasteWithOwner[], number]> => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const filter = q ? await pasteSearchFilter(q) : {};

    return Promise.all([
        PastebinModel.aggregate<PasteWithOwner>([
            { $match: filter },
            { $sort: { [sortBy]: sortDirection, _id: sortDirection } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            ...pasteOwnerStages,
            {
                $project: {
                    _id: 1,
                    language: 1,
                    preview: { $substrCP: ["$content", 0, PASTE_PREVIEW_LENGTH] },
                    addedOn: 1,
                    owner: 1
                }
            }
        ]).exec(),
        countMatching(PastebinModel, filter)
    ]);
};
