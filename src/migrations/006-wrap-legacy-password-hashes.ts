import mongoose from "mongoose";

import { UserModel } from "../database/users";
import { wrapLegacyPasswordHash } from "../helpers/password";

type LegacyPasswordUser = {
    _id: mongoose.Types.ObjectId;
    authentication: { salt: string; password: string };
};

export const wrapLegacyPasswordHashes = async (
    model: typeof UserModel = UserModel
): Promise<void> => {
    const users = (await model
        .find({ "authentication.password": { $type: "string", $ne: "", $not: /^scrypt\$/ } })
        .select("+authentication.salt +authentication.password")
        .lean()) as LegacyPasswordUser[];

    const updates = await Promise.all(
        users.map(async ({ _id, authentication: { salt, password } }) => ({
            updateOne: {
                filter: { _id, "authentication.password": { $eq: password } },
                update: {
                    $set: {
                        "authentication.password": await wrapLegacyPasswordHash(salt, password)
                    }
                }
            }
        }))
    );

    const { modifiedCount } =
        updates.length > 0 ? await model.bulkWrite(updates) : { modifiedCount: 0 };

    console.log(`Legacy password hashes: ${users.length}, wrapped: ${modifiedCount}`);
};
