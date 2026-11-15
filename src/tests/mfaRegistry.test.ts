import { MfaMethod, mfaMethods, mfaOnFilter, mfaResetPaths } from "../helpers/mfa";

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

    it("should not list authentication itself or the challenge", (): void => {
        expect(
            mfaResetPaths.filter(
                (path: string): boolean =>
                    path === "authentication" || isAtOrUnder(path, "authentication.mfaChallenge")
            )
        ).toEqual([]);
    });

    it("should leave backup methods out of the MFA-on filter", (): void => {
        const backups: MfaMethod[] = Object.values(mfaMethods).filter(({ backup }) => backup);

        expect(backups.length).toBeGreaterThan(0);
        expect(
            Object.values(mfaMethods).every(
                ({ backup, onFilter }: MfaMethod): boolean => Boolean(backup) !== Boolean(onFilter)
            )
        ).toBe(true);
        backups
            .flatMap(({ storedPaths }: MfaMethod): string[] => storedPaths)
            .forEach((path: string): void =>
                expect(JSON.stringify(mfaOnFilter)).not.toContain(path)
            );
    });
});
