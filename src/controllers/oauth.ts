import express from "express";
import { get, isPlainObject } from "lodash";

import { User, findUsersByEmailsOrIds } from "../database/users";
import { Responses } from "../constants/responses";
import { OAUTH_STATUS_ENTRIES_MAX } from "../constants/limits";
import { isSuperuserEmail, normalizeEmail } from "../helpers";
import { isObjectId } from "../helpers/prisma";
import { isApiKeyToken } from "../helpers/apiKeys";
import { clientScopes } from "../helpers/oauthClients";
import { liveApiKeyOf, recordUse } from "../middlewares";
import { limitInactiveIntrospections } from "../middlewares/rateLimit";

const stringListOf = (value: unknown): string[] | null =>
    value === undefined
        ? []
        : Array.isArray(value) && value.every((item: unknown): boolean => typeof item === "string")
          ? value
          : null;

const accountStatus = (user: User | undefined) =>
    user
        ? {
              exists: true,
              id: user._id,
              username: user.username,
              isSuperuser: isSuperuserEmail(user.email),
              suspendedAt: user.suspendedAt ?? null
          }
        : { exists: false };

export const getAccountsStatus = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        if (!req.oauthClient.accountStatus) {
            return res.status(403).json({ error: Responses.OAuth.accountStatusNotAllowed });
        }

        const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};
        const emails: string[] | null = stringListOf(body.emails);
        const subs: string[] | null = stringListOf(body.subs);
        const total: number = (emails?.length ?? 0) + (subs?.length ?? 0);

        if (!emails || !subs || total < 1 || total > OAUTH_STATUS_ENTRIES_MAX) {
            return res.status(400).json({ error: Responses.OAuth.invalidStatusRequest });
        }

        const normalizedEmails: string[] = emails.map(normalizeEmail);
        const ids: string[] = subs
            .filter(isObjectId)
            .map((sub: string): string => sub.toLowerCase());
        const users: User[] = await findUsersByEmailsOrIds(normalizedEmails, ids);

        return res.status(200).json({
            accounts: [
                ...emails.map((email: string, index: number) => ({
                    email,
                    ...accountStatus(
                        users.find(({ email }: User): boolean => email === normalizedEmails[index])
                    )
                })),
                ...subs.map((sub: string) => ({
                    sub,
                    ...accountStatus(
                        users.find(({ _id }: User): boolean => _id === sub.toLowerCase())
                    )
                }))
            ]
        });
    } catch (error) {
        return next(error);
    }
};

export const introspectApiKey = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const token: unknown = get(req, "body.token");

        if (typeof token !== "string") {
            return res.status(400).json({ error: Responses.OAuth.missingToken });
        }

        if (!isApiKeyToken(token)) {
            return res.status(200).json({ active: false });
        }

        const now: Date = new Date();
        const live = await liveApiKeyOf(token, now);
        const scopes: string[] = live
            ? clientScopes(req.oauthClient).filter((scope: string): boolean =>
                  live.apiKey.scopes.includes(scope)
              )
            : [];

        if (scopes.length === 0) {
            return limitInactiveIntrospections(req, res, (error?: unknown) =>
                error ? next(error) : res.status(200).json({ active: false })
            );
        }

        const { user, apiKey } = live;
        recordUse(user._id, apiKey, now);

        return res.status(200).json({
            active: true,
            sub: user._id,
            email: user.email,
            username: user.username,
            scopes,
            expiresAt: apiKey.expiresAt ?? null
        });
    } catch (error) {
        return next(error);
    }
};
