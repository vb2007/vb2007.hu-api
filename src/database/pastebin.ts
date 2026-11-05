import mongoose from "mongoose";
import { escapeRegExp } from "lodash";

import { SortOrder } from "./userUploads";
import { UserModel } from "./users";

export const pasteLanguagePattern: RegExp = /^[a-z0-9+#-]{1,32}$/;
export const pasteMinLength: number = 2;
export const pasteMaxLength: number = 10000;
export const pastePreviewLength: number = 100;

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

const pasteOwnerStages: mongoose.PipelineStage.FacetPipelineStage[] = [
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

const pasteSearchFilter = async (q: string): Promise<mongoose.FilterQuery<unknown>> => {
    const pattern = { $regex: escapeRegExp(q), $options: "i" };
    const ownerIds = await UserModel.distinct("_id", { username: pattern });

    return { $or: [{ addedBy: { $in: ownerIds } }, { language: pattern }] };
};

export const findPastesWithOwners = async ({
    limit,
    page,
    sortBy,
    sortOrder,
    q
}: AdminPasteListOptions): Promise<[PasteWithOwner[], number]> => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;

    const [{ pastes, total }] = await PastebinModel.aggregate<{
        pastes: PasteWithOwner[];
        total: { count: number }[];
    }>([
        { $match: q ? await pasteSearchFilter(q) : {} },
        {
            $facet: {
                pastes: [
                    { $sort: { [sortBy]: sortDirection, _id: sortDirection } },
                    { $skip: (page - 1) * limit },
                    { $limit: limit },
                    ...pasteOwnerStages,
                    {
                        $project: {
                            _id: 1,
                            language: 1,
                            preview: { $substrCP: ["$content", 0, pastePreviewLength] },
                            addedOn: 1,
                            owner: 1
                        }
                    }
                ],
                total: [{ $count: "count" }]
            }
        }
    ]).exec();

    return [pastes, total[0]?.count ?? 0];
};
