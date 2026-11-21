import express from "express";
import { get } from "lodash";

import { getUserById } from "../database/users";
import { ApiKey, addApiKey, hasApiKey, removeApiKey, rotateApiKey } from "../database/apiKeys";
import { API_KEYS_MAX, API_KEY_EXPIRY_DEFAULT_DAYS } from "../constants/limits";
import { Responses } from "../constants/responses";
import { SecurityChanges } from "../constants/emails";
import { mailSecurityNotice } from "../helpers/securityNotice";
import { answerMfaReauthLost, reauthedMfaUser } from "../helpers/reauth";
import {
    apiKeyHintOf,
    apiKeyNameError,
    createApiKeyId,
    createApiKeyToken,
    expiresAtOf,
    hashApiKey,
    isAdminScope,
    isApiKeyId,
    isApiKeyLifetime,
    isApiKeyScopeList,
    lifetimeMsOf,
    mayGrantScopes,
    toApiKeyListItem
} from "../helpers/apiKeys";

const identityId = (req: express.Request): string => get(req, "identity._id");

const findApiKey = (apiKeys: readonly ApiKey[] | undefined, id: string): ApiKey | undefined =>
    apiKeys?.find((apiKey: ApiKey): boolean => apiKey.id === id);

const withNewToken = (apiKey: ApiKey, lifetimeMs: number | null) => {
    const token: string = createApiKeyToken();
    const createdAt: Date = new Date();

    return {
        token,
        apiKey: {
            ...apiKey,
            hash: hashApiKey(token),
            hint: apiKeyHintOf(token),
            createdAt,
            expiresAt: expiresAtOf(createdAt, lifetimeMs)
        }
    };
};

const answerWithToken = (
    res: express.Response,
    status: number,
    message: string,
    apiKey: ApiKey,
    token: string
) =>
    res
        .status(status)
        .set("Cache-Control", "no-store")
        .json({ message, apiKey: { ...toApiKeyListItem(apiKey), token } });

export const listApiKeys = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const user = await getUserById(identityId(req));

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res
            .status(200)
            .json({ apiKeys: (user.authentication?.apiKeys ?? []).map(toApiKeyListItem) });
    } catch (error) {
        return next(error);
    }
};

export const createApiKey = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { name, scopes, expiresInDays } = req.body;

        const nameError: string | null = apiKeyNameError(name);
        if (nameError) {
            return res.status(400).json({ error: nameError });
        }

        if (!isApiKeyScopeList(scopes)) {
            return res.status(400).json({ error: Responses.ApiKeys.invalidScopes });
        }

        if (expiresInDays !== undefined && !isApiKeyLifetime(expiresInDays)) {
            return res.status(400).json({ error: Responses.ApiKeys.invalidExpiry });
        }

        if (!mayGrantScopes(scopes, get(req, "identity.email"))) {
            return res.status(403).json({ error: Responses.ApiKeys.adminScopesNotAllowed });
        }

        const reauth = await reauthedMfaUser(req, res);
        if (!reauth) {
            return;
        }

        const { userId, user, reauthed } = reauth;
        const { token, apiKey } = withNewToken(
            { id: createApiKeyId(), name: name.trim(), scopes } as ApiKey,
            lifetimeMsOf(expiresInDays === undefined ? API_KEY_EXPIRY_DEFAULT_DAYS : expiresInDays)
        );

        const { matchedCount } = await addApiKey(reauthed, apiKey, API_KEYS_MAX);

        if (matchedCount === 0) {
            const current = await getUserById(userId);

            return (current?.authentication?.apiKeys?.length ?? 0) >= API_KEYS_MAX
                ? res.status(409).json({ error: Responses.ApiKeys.tooManyApiKeys })
                : answerMfaReauthLost(res, user);
        }

        answerWithToken(res, 201, Responses.ApiKeys.apiKeyCreatedSuccess, apiKey, token);

        await mailSecurityNotice(
            user,
            SecurityChanges.apiKeyCreated(apiKey.name, scopes.some(isAdminScope))
        );
    } catch (error) {
        return next(error);
    }
};

export const rotateApiKeyById = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;
        const { expiresInDays } = req.body;

        if (expiresInDays !== undefined && !isApiKeyLifetime(expiresInDays)) {
            return res.status(400).json({ error: Responses.ApiKeys.invalidExpiry });
        }

        if (!isApiKeyId(id)) {
            return res.status(404).json({ error: Responses.ApiKeys.apiKeyNotFound });
        }

        const reauth = await reauthedMfaUser(req, res);
        if (!reauth) {
            return;
        }

        const { userId, user, reauthed } = reauth;
        const previous: ApiKey | undefined = findApiKey(user.authentication?.apiKeys, id);

        if (!previous) {
            return res.status(404).json({ error: Responses.ApiKeys.apiKeyNotFound });
        }

        const { token, apiKey } = withNewToken(
            previous,
            expiresInDays === undefined
                ? previous.expiresAt
                    ? previous.expiresAt.getTime() - previous.createdAt.getTime()
                    : null
                : lifetimeMsOf(expiresInDays)
        );

        const { matchedCount } = await rotateApiKey(reauthed, id, previous.hash, apiKey);

        if (matchedCount === 0) {
            return (await hasApiKey(userId, id))
                ? answerMfaReauthLost(res, user)
                : res.status(404).json({ error: Responses.ApiKeys.apiKeyNotFound });
        }

        answerWithToken(res, 200, Responses.ApiKeys.apiKeyRotatedSuccess, apiKey, token);

        await mailSecurityNotice(
            user,
            SecurityChanges.apiKeyRotated(apiKey.name, apiKey.scopes.some(isAdminScope))
        );
    } catch (error) {
        return next(error);
    }
};

export const deleteApiKeyById = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;
        const user = isApiKeyId(id) ? await removeApiKey(identityId(req), id) : null;
        const apiKey: ApiKey | undefined = findApiKey(user?.authentication?.apiKeys, id);

        if (!apiKey) {
            return res.status(404).json({ error: Responses.ApiKeys.apiKeyNotFound });
        }

        res.status(200).json({ message: Responses.ApiKeys.apiKeyDeletedSuccess });

        await mailSecurityNotice(user, SecurityChanges.apiKeyDeleted(apiKey.name));
    } catch (error) {
        return next(error);
    }
};
