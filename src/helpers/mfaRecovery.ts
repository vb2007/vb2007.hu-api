import crypto from "crypto";

import { authentication } from ".";
import { reauthedSessionFilter } from "../database/users";
import { setMfaRecoveryCodes } from "../database/mfaRecovery";
import { MFA_RECOVERY_CODES } from "../constants/limits";
import type { MfaMethod, MfaUser } from "./mfa";

const alphabet: string = "abcdefghijklmnopqrstuvwxyz234567";
const recoveryCodePattern: RegExp = /^[a-z2-7]{10}$/;

const createRecoveryCode = (): string =>
    Array.from({ length: 10 }, (): string => alphabet[crypto.randomInt(alphabet.length)]).join("");

const normalizeRecoveryCode = (code: string): string => code.toLowerCase().replace(/[\s-]/g, "");

const recoveryCodeHash = (id: string, code: string): string =>
    authentication(`mfaRecovery:${id}`, code);

const sentCodeHash = (user: MfaUser, code: unknown): string | null => {
    const normalized: string = normalizeRecoveryCode(String(code));

    return recoveryCodePattern.test(normalized)
        ? recoveryCodeHash(user._id.toString(), normalized)
        : null;
};

export const issueMfaRecoveryCodes = async (
    id: string,
    reauthed: ReturnType<typeof reauthedSessionFilter>,
    replace: boolean = false
): Promise<string[] | null> => {
    const codes: string[] = Array.from({ length: MFA_RECOVERY_CODES }, createRecoveryCode);
    const { modifiedCount } = await setMfaRecoveryCodes(
        reauthed,
        codes.map((code: string): string => recoveryCodeHash(id, code)),
        replace
    );

    return modifiedCount === 1
        ? codes.map((code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`)
        : null;
};

export const recoveryMfa: MfaMethod = {
    fields: "+authentication.mfaRecoveryCodes",
    storedPaths: ["authentication.mfaRecoveryCodes"],
    backup: true,
    isOn: (authentication) => Boolean(authentication?.mfaRecoveryCodes?.length),
    isWellFormed: ({ code }) => typeof code === "string" && code !== "",
    verify: (user, { code }) =>
        Boolean(user.authentication.mfaRecoveryCodes?.includes(sentCodeHash(user, code))),
    spend: (user, { code }) => {
        const hash: string | null = sentCodeHash(user, code);

        return hash
            ? {
                  filter: { "authentication.mfaRecoveryCodes": { $eq: hash } },
                  update: { $pull: { "authentication.mfaRecoveryCodes": hash } }
              }
            : null;
    }
};
