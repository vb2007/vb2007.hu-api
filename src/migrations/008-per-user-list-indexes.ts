import mongoose from "mongoose";

import { UserUploadsModel } from "../database/userUploads";
import { ShortUrlModel } from "../database/shortUrls";
import { isIndexNotFoundError } from "../helpers/mongoose";

const replaceIndex = async (
    collection: mongoose.Collection,
    key: Record<string, 1 | -1>,
    oldIndexName: string
): Promise<boolean> => {
    await collection.createIndex(key);

    try {
        await collection.dropIndex(oldIndexName);
        return true;
    } catch (error) {
        if (isIndexNotFoundError(error)) {
            return false;
        }

        throw error;
    }
};

export const addIdToPerUserListIndexes = async (
    uploadsModel: typeof UserUploadsModel = UserUploadsModel,
    shortUrlsModel: typeof ShortUrlModel = ShortUrlModel
): Promise<void> => {
    const replacedUploadsIndex: boolean = await replaceIndex(
        uploadsModel.collection,
        { uploadedBy: 1, uploadedOn: -1, _id: -1 },
        "uploadedBy_1_uploadedOn_-1"
    );
    const replacedShortUrlsIndex: boolean = await replaceIndex(
        shortUrlsModel.collection,
        { addedBy: 1, addedOn: -1, _id: -1 },
        "addedBy_1_addedOn_-1"
    );

    if (!replacedUploadsIndex && !replacedShortUrlsIndex) {
        console.log("Per-user list indexes already include _id");
        return;
    }

    console.log("Per-user list indexes now include _id");
};
