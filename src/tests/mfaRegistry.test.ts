import mongoose from "mongoose";
import { mergeMfaUpdates } from "../database/mfa";
import { mfaMethods, mfaMethodsOn, mfaOnFilter, mfaResetPaths } from "../helpers/mfa";

const isAtOrUnder = (path: string, parent: string): boolean =>
    path === parent || path.startsWith(`${parent}.`);

describe("MFA registry", (): void => {
    it("should never store anything at or under the passkeys", (): void => {
        expect(
            mfaResetPaths.filter((path: string): boolean =>
                isAtOrUnder(path, "authentication.passkeys")
            )
        ).toEqual([]);
    });

    it("should not list a path at or under another one", (): void => {
        expect(
            mfaResetPaths.filter((path: string, index: number): boolean =>
                mfaResetPaths.some(
                    (other: string, otherIndex: number): boolean =>
                        otherIndex !== index && isAtOrUnder(path, other)
                )
            )
        ).toEqual([]);
    });

    it("should never let backup methods alone turn MFA on", (): void => {
        const backups = Object.values(mfaMethods).filter(({ backup }) => backup);

        expect(backups).toContain(mfaMethods.passkey);
        expect(backups).toContain(mfaMethods.recovery);
        expect(mfaOnFilter.$or).toEqual(
            Object.values(mfaMethods)
                .filter(({ backup }) => !backup)
                .map(({ onFilter }) => onFilter)
        );
        expect(mfaOnFilter.$or.every(Boolean)).toBe(true);
        expect(mfaMethodsOn({ passkeys: [{ credentialId: "a" }] } as never)).toEqual([]);
        expect(mfaMethodsOn({ mfaRecoveryCodes: ["a"] } as never)).toEqual([]);
        expect(
            mfaMethodsOn({ passkeys: [{ credentialId: "a" }], mfaRecoveryCodes: ["a"] } as never)
        ).toEqual([]);
        expect(
            mfaMethodsOn({ mfaEmail: true, passkeys: [{ credentialId: "a" }] } as never)
        ).toEqual(["email", "passkey"]);
        expect(
            mfaMethodsOn({
                mfaEmail: true,
                passkeys: [{ credentialId: "a" }],
                mfaRecoveryCodes: ["a"]
            } as never)
        ).toEqual(["email", "passkey", "recovery"]);
        expect(mfaMethodsOn({ mfaEmail: true, mfaRecoveryCodes: [] } as never)).toEqual(["email"]);
    });

    it("should not list authentication itself or the challenge", (): void => {
        expect(
            mfaResetPaths.filter(
                (path: string): boolean =>
                    path === "authentication" || isAtOrUnder(path, "authentication.mfaChallenge")
            )
        ).toEqual([]);
    });

    it("should merge a method's spend into the session update without dropping either", (): void => {
        expect(
            mergeMfaUpdates(
                { $set: { session: 1 }, $unset: { challenge: 1 } },
                { $set: { session: 2, counter: 3 }, $pull: { codes: "a" } }
            )
        ).toEqual({
            $set: { session: 1, counter: 3 },
            $unset: { challenge: 1 },
            $pull: { codes: "a" }
        });
    });

    it("should spend no recovery code for a code of the wrong shape", (): void => {
        const user = { _id: new mongoose.Types.ObjectId(), authentication: {} } as never;

        expect(mfaMethods.recovery.spend(user, { code: "abc" })).toBeNull();
        expect(mfaMethods.recovery.spend(user, { code: "abcde-fghij" })).toMatchObject({
            filter: { "authentication.mfaRecoveryCodes": { $eq: expect.any(String) } }
        });
    });
});
