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
        expect(mfaOnFilter.$or).toEqual(
            Object.values(mfaMethods)
                .filter(({ backup }) => !backup)
                .map(({ onFilter }) => onFilter)
        );
        expect(mfaOnFilter.$or.every(Boolean)).toBe(true);
        expect(mfaMethodsOn({ passkeys: [{ credentialId: "a" }] } as never)).toEqual([]);
        expect(
            mfaMethodsOn({ mfaEmail: true, passkeys: [{ credentialId: "a" }] } as never)
        ).toEqual(["email", "passkey"]);
    });

    it("should not list authentication itself or the challenge", (): void => {
        expect(
            mfaResetPaths.filter(
                (path: string): boolean =>
                    path === "authentication" || isAtOrUnder(path, "authentication.mfaChallenge")
            )
        ).toEqual([]);
    });
});
