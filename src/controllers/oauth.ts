import express from "express";
import { isPlainObject } from "lodash";

import { User, findUsersByEmailsOrIds } from "../database/users";
import { Responses } from "../constants/responses";
import { OAUTH_STATUS_ENTRIES_MAX } from "../constants/limits";
import { isSuperuserEmail, normalizeEmail } from "../helpers";
import { isObjectId } from "../helpers/prisma";

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

        if (
            !isPlainObject(req.body) ||
            !emails ||
            !subs ||
            total < 1 ||
            total > OAUTH_STATUS_ENTRIES_MAX
        ) {
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
