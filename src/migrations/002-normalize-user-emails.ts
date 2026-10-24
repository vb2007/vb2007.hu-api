import mongoose from "mongoose";
import { groupBy } from "lodash";

import { UserModel } from "../database/users";
import { normalizeEmail } from "../helpers";

type UserEmail = {
    _id: mongoose.Types.ObjectId;
    email: string;
};

export const normalizeUserEmails = async (model: typeof UserModel = UserModel): Promise<void> => {
    const users = (await model.find().select("email").lean()) as UserEmail[];

    const duplicates: string[] = Object.values(groupBy(users, ({ email }) => normalizeEmail(email)))
        .filter((group) => group.length > 1)
        .map((group) => group.map(({ _id }) => _id.toString()).join(", "));

    if (duplicates.length > 0) {
        throw new Error(
            `Users whose e-mails differ only in case, change or remove them first: ${duplicates.join("; ")}`
        );
    }

    const updates = users
        .filter(({ email }) => email !== normalizeEmail(email))
        .map(({ _id, email }) => ({
            updateOne: { filter: { _id }, update: { $set: { email: normalizeEmail(email) } } }
        }));

    if (updates.length > 0) {
        await model.bulkWrite(updates);
    }

    console.log(`Users: ${users.length}, e-mails normalized: ${updates.length}`);
};
