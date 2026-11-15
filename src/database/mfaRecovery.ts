import { UserModel, reauthedSessionFilter } from "./users";
import type { MfaOnFilter } from "./mfa";

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

export const dropMfaRecoveryCodesWithout = (id: string, onFilter: MfaOnFilter) =>
    UserModel.updateOne({ _id: id, $nor: onFilter.$or }, { $unset: { [recoveryCodes]: 1 } });
