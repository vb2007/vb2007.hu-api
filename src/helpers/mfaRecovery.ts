import crypto from "crypto";

import { authentication } from ".";
import { reauthedSessionFilter } from "../database/users";
import { setMfaRecoveryCodes, useMfaRecoveryCode } from "../database/mfaRecovery";
import { MFA_RECOVERY_CODES } from "../constants/limits";
import type { MfaMethod } from "./mfa";

const alphabet: string = "abcdefghijklmnopqrstuvwxyz234567";
const recoveryCodePattern: RegExp = /^[a-z2-7]{10}$/;

const createRecoveryCode = (): string =>
    Array.from({ length: 10 }, (): string => alphabet[crypto.randomInt(alphabet.length)]).join("");

export const normalizeRecoveryCode = (code: string): string =>
    code.toLowerCase().replace(/[\s-]/g, "");

const recoveryCodeHash = (id: string, code: string): string =>
    authentication(`mfaRecovery:${id}`, code);

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
    verify: async (user, { code }) => {
        const id: string = user._id.toString();
        const normalized: string = normalizeRecoveryCode(String(code));

        if (!recoveryCodePattern.test(normalized)) {
            return false;
        }

        const { modifiedCount } = await useMfaRecoveryCode(
            id,
            user.authentication.mfaChallenge.hash,
            recoveryCodeHash(id, normalized)
        );
        return modifiedCount === 1;
    }
};
