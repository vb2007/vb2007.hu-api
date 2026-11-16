import { MongoFieldFilter, MongoOrExpr } from "@prisma/orm-mongo/query-ast/execution";
import { createFieldAccessor } from "@prisma/orm-mongo/query-builder";
import { UserFields } from "../database/users";
import { mfaSessionUpdate, startMfaSession } from "../database/mfa";
import { mfaMethods, mfaMethodsOn, mfaOnFilter, mfaResetPaths } from "../helpers/mfa";
import { newObjectId } from "../helpers/prisma";

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
        const onFilters = (mfaOnFilter as MongoOrExpr).exprs;

        expect(backups).toContain(mfaMethods.passkey);
        expect(backups).toContain(mfaMethods.recovery);
        expect(onFilters).toEqual(
            Object.values(mfaMethods)
                .filter(({ backup }) => !backup)
                .map(({ onFilter }) => onFilter)
        );
        expect(onFilters.every(Boolean)).toBe(true);
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
        const expiresAt: Date = new Date();
        const update = mfaSessionUpdate({ hash: "session", expiresAt }, undefined, {
            filter: MongoFieldFilter.eq("authentication.mfaRecoveryCodes", "a"),
            update: (f) => [
                f("authentication.mfaTotpLastStep").set(3),
                f("authentication.mfaRecoveryCodes").pull("a")
            ]
        })(createFieldAccessor() as unknown as UserFields);

        expect(update).toEqual([
            { op: "$set", path: "authentication.sessionToken", value: "session" },
            { op: "$set", path: "authentication.sessionExpiresAt", value: expiresAt },
            { op: "$unset", path: "authentication.mfaChallenge" },
            { op: "$set", path: "authentication.mfaTotpLastStep", value: 3 },
            { op: "$pull", path: "authentication.mfaRecoveryCodes", value: "a" }
        ]);
    });

    it("should refuse a spend that touches a session path the login sets", async (): Promise<void> => {
        await expect(
            startMfaSession(
                newObjectId(),
                "challenge",
                { hash: "session", expiresAt: new Date() },
                undefined,
                {
                    filter: MongoFieldFilter.eq("authentication.mfaRecoveryCodes", "a"),
                    update: (f) => [f("authentication.sessionToken").set("spent")]
                }
            )
        ).rejects.toThrow("Update spec collision");
    });

    it("should spend no recovery code for a code of the wrong shape", (): void => {
        const user = { _id: newObjectId(), authentication: {} } as never;

        expect(mfaMethods.recovery.spend(user, { code: "abc" })).toBeNull();
        expect(mfaMethods.recovery.spend(user, { code: "abcde-fghij" })).toMatchObject({
            filter: {
                field: "authentication.mfaRecoveryCodes",
                op: "$eq",
                value: expect.any(String)
            }
        });
    });
});
