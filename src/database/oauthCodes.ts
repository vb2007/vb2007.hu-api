import { MongoFieldFilter } from "@prisma/orm-mongo/query-ast/execution";

import { db } from "../prisma/db";
import { allOf, firstOf } from "../helpers/prisma";

export interface OauthCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    nonce: string;
    userId: string;
    expiresAt: Date;
}

export const saveOauthCode = (hash: string, code: OauthCode) =>
    db.orm.oauthcodes.create({ id: hash, ...code });

export const claimOauthCode = (hash: string) =>
    firstOf(
        db.query
            .from("oauthcodes")
            .match(
                allOf(
                    MongoFieldFilter.eq("_id", hash),
                    MongoFieldFilter.gt("expiresAt", new Date())
                )
            )
            .findOneAndDelete()
    );
