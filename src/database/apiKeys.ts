import {
    MongoExistsExpr,
    MongoFieldFilter,
    MongoFilterExpr
} from "@prisma/orm-mongo/query-ast/execution";
import type { MongoValue } from "@prisma/orm-mongo/value";

import { allOf, idIs } from "../helpers/prisma";
import { User, findAndUpdateUser, updateUser, userExists } from "./users";

export interface ApiKey {
    id: string;
    name: string;
    hash: string;
    hint: string;
    scopes: string[];
    createdAt: Date;
    expiresAt?: Date | null;
    lastUsedAt?: Date | null;
}

export const addApiKey = (reauthed: MongoFilterExpr, apiKey: ApiKey, maxApiKeys: number) =>
    updateUser(
        allOf(reauthed, MongoExistsExpr.notExists(`authentication.apiKeys.${maxApiKeys - 1}`)),
        (f) => [
            f("authentication.apiKeys").push({
                ...apiKey,
                expiresAt: apiKey.expiresAt ?? null,
                lastUsedAt: null
            } as MongoValue)
        ]
    );

const ownApiKey = (id: string, apiKeyId: string): MongoFilterExpr =>
    allOf(idIs(id), MongoFieldFilter.eq("authentication.apiKeys.id", apiKeyId));

export const hasApiKey = (id: string, apiKeyId: string): Promise<boolean> =>
    userExists(ownApiKey(id, apiKeyId));

export const rotateApiKey = (
    reauthed: MongoFilterExpr,
    apiKeyId: string,
    previousHash: string,
    { hash, hint, createdAt, expiresAt }: ApiKey
) =>
    updateUser(
        allOf(
            reauthed,
            MongoFieldFilter.of("authentication.apiKeys", "$elemMatch", {
                id: { $eq: apiKeyId },
                hash: { $eq: previousHash }
            })
        ),
        (f) => [
            f.rawPath("authentication.apiKeys.$.hash").set(hash),
            f.rawPath("authentication.apiKeys.$.hint").set(hint),
            f.rawPath("authentication.apiKeys.$.createdAt").set(createdAt),
            f.rawPath("authentication.apiKeys.$.expiresAt").set(expiresAt ?? null),
            f.rawPath("authentication.apiKeys.$.lastUsedAt").set(null)
        ]
    );

export const removeApiKey = (id: string, apiKeyId: string): Promise<User | null> =>
    findAndUpdateUser(
        ownApiKey(id, apiKeyId),
        (f) => [f("authentication.apiKeys").pull({ id: { $eq: apiKeyId } })],
        "before"
    );

export const removeAllApiKeys = (id: string): Promise<User | null> =>
    findAndUpdateUser(idIs(id), (f) => [f("authentication.apiKeys").unset()], "before");
