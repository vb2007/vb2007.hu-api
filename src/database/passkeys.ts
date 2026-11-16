import mongoose from "mongoose";
import { MongoParamRef } from "@prisma/orm-mongo/value";
import { MongoFieldFilter } from "@prisma/orm-mongo/query-ast/execution";

import { db } from "../prisma/db";
import { allOf, firstOf, objectIdOf } from "../helpers/prisma";

export interface Passkey {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    name: string;
    createdAt: Date;
    lastUsedAt?: Date | null;
}

export const PasskeySchema = new mongoose.Schema(
    {
        credentialId: { type: String, required: true },
        publicKey: { type: String, required: true },
        counter: { type: Number, required: true },
        transports: { type: [String], default: undefined },
        name: { type: String, required: true },
        createdAt: { type: Date, required: true },
        lastUsedAt: { type: Date, default: null }
    },
    { _id: false }
);

const PasskeyChallengeSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    challenge: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, required: true, expires: 0 }
});

export const PasskeyChallengeModel = mongoose.model("PasskeyChallenge", PasskeyChallengeSchema);

const passkeyUserIdOf = (userId: string | null): MongoParamRef | null =>
    userId === null ? null : objectIdOf(userId);

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
