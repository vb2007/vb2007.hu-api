import {
    MongoExistsExpr,
    MongoFilterExpr,
    MongoNotExpr
} from "@prisma/orm-mongo/query-ast/execution";

import { updateUser } from "./users";
import { allOf, idIs } from "../helpers/prisma";

const recoveryCodes: string = "authentication.mfaRecoveryCodes";

export const setMfaRecoveryCodes = (
    reauthed: MongoFilterExpr,
    hashes: string[],
    replace: boolean
) =>
    updateUser(
        allOf(reauthed, ...(replace ? [] : [MongoExistsExpr.notExists(`${recoveryCodes}.0`)])),
        (f) => [f("authentication.mfaRecoveryCodes").set(hashes)]
    );

export const dropMfaRecoveryCodesWithout = (id: string, onFilter: MongoFilterExpr) =>
    updateUser(allOf(idIs(id), new MongoNotExpr(onFilter)), (f) => [
        f("authentication.mfaRecoveryCodes").unset()
    ]);
