import { UserModel, activeSessionFilter, reauthedSessionFilter } from "./users";

export type SessionBoundFilter = (
    | ReturnType<typeof reauthedSessionFilter>
    | ({ _id: string } & ReturnType<typeof activeSessionFilter>)
) &
    Record<string, unknown>;
import type { MfaOnFilter } from "./mfa";

const recoveryCodes: string = "authentication.mfaRecoveryCodes";

export const setMfaRecoveryCodes = (
    reauthed: SessionBoundFilter,
    hashes: string[],
    replace: boolean
) =>
    UserModel.updateOne(
        { ...reauthed, ...(!replace && { [`${recoveryCodes}.0`]: { $exists: false } }) },
        { $set: { [recoveryCodes]: hashes } }
    );

export const dropMfaRecoveryCodesWithout = (id: string, onFilter: MfaOnFilter) =>
    UserModel.updateOne({ _id: id, $nor: onFilter.$or }, { $unset: { [recoveryCodes]: 1 } });
