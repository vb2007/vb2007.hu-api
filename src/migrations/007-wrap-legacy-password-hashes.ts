import mongoose from "mongoose";

import { UserModel } from "../database/users";
import { wrapLegacyPasswordHash } from "../helpers/password";

type UserPassword = {
    _id: mongoose.Types.ObjectId;
    authentication: { password: string; salt: string };
};

export const wrapLegacyPasswordHashes = async (
    model: typeof UserModel = UserModel
): Promise<void> => {
    const users = model
        .find({
            "authentication.password": { $type: "string", $ne: "", $not: /^scrypt\$/ },
            "authentication.salt": { $type: "string" }
        })
        .select("+authentication.password +authentication.salt")
        .lean()
        .cursor();
    let wrapped: number = 0;
    let skipped: number = 0;

    for await (const user of users) {
        const { _id, authentication } = user as unknown as UserPassword;
        const { modifiedCount } = await model.updateOne(
            {
                _id,
                "authentication.password": { $eq: authentication.password },
                "authentication.salt": { $eq: authentication.salt }
            },
            {
                $set: {
                    "authentication.password": await wrapLegacyPasswordHash(
                        authentication.salt,
                        authentication.password
                    )
                }
            }
        );

        if (modifiedCount === 1) {
            wrapped++;
        } else {
            skipped++;
        }
    }

    console.log(`Legacy password hashes wrapped: ${wrapped}, skipped: ${skipped}`);
};
