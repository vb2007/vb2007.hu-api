import { UserModel, reauthedSessionFilter } from "./users";

const recoveryCodes: string = "authentication.mfaRecoveryCodes";

export const setMfaRecoveryCodes = (
    reauthed: ReturnType<typeof reauthedSessionFilter>,
    hashes: string[],
    replace: boolean
) =>
    UserModel.updateOne(
        { ...reauthed, ...(!replace && { [`${recoveryCodes}.0`]: { $exists: false } }) },
        { $set: { [recoveryCodes]: hashes } }
    );

export const useMfaRecoveryCode = (id: string, challengeHash: string, hash: string) =>
    UserModel.updateOne(
        {
            _id: id,
            "authentication.mfaChallenge.hash": { $eq: challengeHash },
            [recoveryCodes]: { $eq: hash }
        },
        { $pull: { [recoveryCodes]: hash } }
    );
