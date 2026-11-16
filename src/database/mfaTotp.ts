import { MongoFieldFilter, MongoFilterExpr } from "@prisma/orm-mongo/query-ast/execution";

import { activeSessionFilter, findAndUpdateUser, findUser, updateUser } from "./users";
import { allOf, idIs } from "../helpers/prisma";
import { MFA_TOTP_SETUP_ATTEMPTS } from "../constants/limits";

export interface MfaTotpSetup {
    secret: string;
    session: string;
    expiresAt: Date;
    attempts: number;
}

export const setMfaTotpSetup = (reauthed: MongoFilterExpr, setup: MfaTotpSetup) =>
    updateUser(reauthed, (f) => [f("authentication.mfaTotpSetup").set({ ...setup })]);

export const claimMfaTotpSetupTry = (id: string, sessionHash: string) =>
    findAndUpdateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("authentication.mfaTotpSetup.session", sessionHash),
            MongoFieldFilter.gt("authentication.mfaTotpSetup.expiresAt", new Date()),
            MongoFieldFilter.lt("authentication.mfaTotpSetup.attempts", MFA_TOTP_SETUP_ATTEMPTS)
        ),
        (f) => [f("authentication.mfaTotpSetup.attempts").inc(1)],
        "after"
    );

export const getMfaTotpSetup = (id: string, sessionHash: string) =>
    findUser(idIs(id), MongoFieldFilter.eq("authentication.mfaTotpSetup.session", sessionHash));

export const enableMfaTotp = (
    id: string,
    sessionToken: string,
    setup: Pick<MfaTotpSetup, "secret" | "session">,
    step: number
) =>
    findAndUpdateUser(
        allOf(
            idIs(id),
            activeSessionFilter(sessionToken),
            MongoFieldFilter.eq("authentication.mfaTotpSetup.secret", setup.secret),
            MongoFieldFilter.eq("authentication.mfaTotpSetup.session", setup.session)
        ),
        (f) => [
            f("authentication.mfaTotpSecret").set(setup.secret),
            f("authentication.mfaTotpLastStep").set(step),
            f("authentication.mfaTotpSetup").unset()
        ],
        "before"
    );
