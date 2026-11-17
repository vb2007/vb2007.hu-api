import { MongoParamRef } from "@prisma/orm-mongo/value";
import { MongoFieldFilter } from "@prisma/orm-mongo/query-ast/execution";

import { db } from "../prisma/db";
import { allOf, firstOf, objectIdParam } from "../helpers/prisma";

export interface Passkey {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    name: string;
    createdAt: Date;
    lastUsedAt?: Date | null;
}

const passkeyUserIdOf = (userId: string | null): MongoParamRef | null =>
    userId === null ? null : objectIdParam(userId);

export const savePasskeyChallenge = (
    idHash: string,
    challenge: string,
    userId: string | null,
    expiresAt: Date
) =>
    firstOf(
        db.query
            .from("passkeychallenges")
            .match(MongoFieldFilter.eq("_id", idHash))
            .upsertOne((f) => [
                f.challenge.set(challenge),
                f.userId.set(passkeyUserIdOf(userId)),
                f.expiresAt.set(expiresAt)
            ])
    );

export const claimPasskeyChallenge = (idHash: string, userId: string | null) =>
    firstOf(
        db.query
            .from("passkeychallenges")
            .match(
                allOf(
                    MongoFieldFilter.eq("_id", idHash),
                    MongoFieldFilter.eq("userId", passkeyUserIdOf(userId)),
                    MongoFieldFilter.gt("expiresAt", new Date())
                )
            )
            .findOneAndDelete()
    );
