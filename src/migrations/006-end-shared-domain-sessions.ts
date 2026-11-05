import { UserModel } from "../database/users";

export const endSharedDomainSessions = async (
    model: typeof UserModel = UserModel
): Promise<void> => {
    const { modifiedCount } = await model.updateMany(
        {
            $or: [
                { "authentication.sessionToken": { $exists: true } },
                { "authentication.sessionExpiresAt": { $exists: true } }
            ]
        },
        { $unset: { "authentication.sessionToken": 1, "authentication.sessionExpiresAt": 1 } }
    );

    console.log(`Shared-domain sessions ended: ${modifiedCount}`);
};
