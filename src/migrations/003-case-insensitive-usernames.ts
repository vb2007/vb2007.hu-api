import mongoose from "mongoose";
import { isMatch } from "lodash";

import { UserModel, usernameCollation } from "../database/users";

type UsernameClash = {
    _id: string;
    ids: mongoose.Types.ObjectId[];
};

const usernameIndexName: string = "username_1";

export const makeUsernamesCaseInsensitive = async (
    model: typeof UserModel = UserModel
): Promise<void> => {
    const clashes: UsernameClash[] = await model
        .aggregate<UsernameClash>([
            { $sort: { _id: 1 } },
            { $group: { _id: "$username", ids: { $push: "$_id" } } },
            { $match: { "ids.1": { $exists: true } } }
        ])
        .collation(usernameCollation);

    if (clashes.length > 0) {
        throw new Error(
            `Users whose usernames differ only in case, rename or remove them first: ${clashes.map(({ ids }) => ids.join(", ")).join("; ")}`
        );
    }

    const usernameIndex = (await model.collection.indexes()).find(
        ({ name }) => name === usernameIndexName
    );
    const isIndexReplaced: boolean =
        Boolean(usernameIndex) && !isMatch(usernameIndex.collation ?? {}, usernameCollation);

    if (isIndexReplaced) {
        await model.collection.dropIndex(usernameIndexName);
    }

    await model.createIndexes();

    console.log(
        isIndexReplaced
            ? "Username index replaced with a case-insensitive one"
            : "Username index already case-insensitive"
    );
};
