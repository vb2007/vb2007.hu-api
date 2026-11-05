import { UserModel } from "../database/users";

export const clearPlaintextSessionTokens = async (
    model: typeof UserModel = UserModel
): Promise<void> => {
    const { modifiedCount } = await model.updateMany(
        {
            "authentication.sessionToken": { $exists: true },
            "authentication.sessionExpiresAt": { $exists: false }
        },
        { $unset: { "authentication.sessionToken": 1 } }
    );

    console.log(`Plain-text session tokens cleared: ${modifiedCount}`);
};
