import crypto from "crypto";
import express from "express";

import { authentication, isSuperuserEmail } from ".";
import { displayNameError } from "./passkeys";
import { isAppScope } from "./oauthClients";
import { ApiKey } from "../database/apiKeys";
import {
    API_KEY_EXPIRY_MAX_DAYS,
    API_KEY_EXPIRY_MIN_DAYS,
    API_KEY_NAME_MAX_LENGTH,
    API_KEY_SCOPES
} from "../constants/limits";
import { Responses } from "../constants/responses";

const dayMs: number = 24 * 60 * 60 * 1000;

export const apiKeyTokenPrefix: string = "vbk_";

export const createApiKeyToken = (): string =>
    `${apiKeyTokenPrefix}${crypto.randomBytes(32).toString("base64url")}`;

export const hashApiKey = (token: string): string => authentication("apiKey", token);

const tokenPattern: string = "vbk_[\\w-]{43}";

const bearerTokenPattern: RegExp = new RegExp(`^(\\S+) (${tokenPattern})$`);

const apiKeyTokenPattern: RegExp = new RegExp(`^${tokenPattern}$`);

export const isApiKeyToken = (token: string): boolean => apiKeyTokenPattern.test(token);

export const bearerTokenOf = (authorization: string): string | null => {
    const [, scheme, token] = bearerTokenPattern.exec(authorization) ?? [];

    return scheme?.toLowerCase() === "bearer" ? token : null;
};

export const isLiveApiKey = ({ expiresAt }: ApiKey, now: Date): boolean =>
    !expiresAt || expiresAt > now;

const apiKeyChallenge = (error: string): string => `Bearer realm="vb2007.hu", error="${error}"`;

export const answerRejectedApiKey = (res: express.Response) => {
    res.locals.apiKeyRejected = true;
    res.set("WWW-Authenticate", apiKeyChallenge("invalid_token"));

    return res.status(401).json({ error: Responses.ApiKeys.invalidApiKey });
};

export const wasApiKeyRejected = (res: express.Response): boolean =>
    res.locals.apiKeyRejected === true;

export const answerScopeMissing = (res: express.Response, scope: string) => {
    res.set("WWW-Authenticate", `${apiKeyChallenge("insufficient_scope")}, scope="${scope}"`);

    return res.status(403).json({ error: Responses.ApiKeys.apiKeyScopeMissing(scope) });
};

export const apiKeyHintOf = (token: string): string => token.slice(-4);

export const createApiKeyId = (): string => crypto.randomBytes(16).toString("hex");

export const isApiKeyId = (id: unknown): id is string =>
    typeof id === "string" && /^[0-9a-f]{32}$/.test(id);

export const isAdminScope = (scope: string): boolean => scope.startsWith("admin:");

export const apiKeyNameError = (name: unknown): string | null =>
    displayNameError(name, API_KEY_NAME_MAX_LENGTH, Responses.ApiKeys);

export const isApiKeyScopeList = (scopes: unknown): scopes is string[] =>
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    new Set(scopes).size === scopes.length &&
    scopes.every(
        (scope: unknown): boolean =>
            API_KEY_SCOPES.includes(scope as string) || isAppScope(scope as string)
    );

export const mayGrantScopes = (scopes: string[], email: string): boolean =>
    !scopes.some(isAdminScope) || isSuperuserEmail(email);

export const isApiKeyLifetime = (days: unknown): days is number | null =>
    days === null ||
    (typeof days === "number" &&
        Number.isInteger(days) &&
        days >= API_KEY_EXPIRY_MIN_DAYS &&
        days <= API_KEY_EXPIRY_MAX_DAYS);

export const lifetimeMsOf = (days: number | null): number | null =>
    days === null ? null : days * dayMs;

export const expiresAtOf = (createdAt: Date, lifetimeMs: number | null): Date | null =>
    lifetimeMs === null ? null : new Date(createdAt.getTime() + lifetimeMs);

export const toApiKeyListItem = ({
    id,
    name,
    hint,
    scopes,
    createdAt,
    expiresAt,
    lastUsedAt
}: ApiKey) => ({
    id,
    name,
    hint,
    scopes,
    createdAt,
    expiresAt: expiresAt ?? null,
    lastUsedAt: lastUsedAt ?? null
});
