import { mfaStoredPaths } from "../helpers/mfa";

const isAtOrUnder = (path: string, parent: string): boolean =>
    path === parent || path.startsWith(`${parent}.`);

describe("MFA registry", (): void => {
    it("should never store anything at or under the passkeys", (): void => {
        expect(
            mfaStoredPaths.filter((path: string): boolean =>
                isAtOrUnder(path, "authentication.passkeys")
            )
        ).toEqual([]);
    });

    it("should not list a path at or under another one", (): void => {
        expect(
            mfaStoredPaths.filter((path: string, index: number): boolean =>
                mfaStoredPaths.some(
                    (other: string, otherIndex: number): boolean =>
                        otherIndex !== index && isAtOrUnder(path, other)
                )
            )
        ).toEqual([]);
    });

    it("should not list authentication itself or the challenge", (): void => {
        expect(
            mfaStoredPaths.filter(
                (path: string): boolean =>
                    path === "authentication" || isAtOrUnder(path, "authentication.mfaChallenge")
            )
        ).toEqual([]);
    });
});
