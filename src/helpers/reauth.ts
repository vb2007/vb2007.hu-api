import express from "express";

import { GITHUB_REAUTH_MINUTES } from "../constants/limits";
import { Responses } from "../constants/responses";
import { answerRejectedCredential, verifyPassword } from "./password";

export const reauthFields: string =
    "+authentication.salt +authentication.password +authentication.githubVerifiedAt";

export const githubReauthSince = (): Date =>
    new Date(Date.now() - GITHUB_REAUTH_MINUTES * 60 * 1000);

export const isGithubVerifiedSince = (verifiedAt: Date | undefined, since: Date): boolean =>
    Boolean(verifiedAt) && verifiedAt >= since && verifiedAt <= new Date();

interface ReauthUser {
    authentication?: { salt?: string; password?: string; githubVerifiedAt?: Date };
}

export const rejectWrongPassword = async (
    res: express.Response,
    user: ReauthUser,
    password: unknown,
    client: string,
    missingError: string = Responses.GithubOauth.missingPassword
) => {
    if (typeof password !== "string" || !password) {
        return res.status(400).json({ error: missingError });
    }

    if (
        !(await verifyPassword(
            user.authentication.salt,
            user.authentication.password,
            password,
            client
        ))
    ) {
        return answerRejectedCredential(res, Responses.Authentication.incorrectPassword);
    }

    return null;
};

export const rejectFailedMfaReauth = async (
    res: express.Response,
    user: ReauthUser,
    password: unknown,
    client: string
) => {
    if (!user.authentication?.password) {
        return isGithubVerifiedSince(user.authentication?.githubVerifiedAt, githubReauthSince())
            ? null
            : res
                  .status(403)
                  .json({ error: Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES) });
    }

    return rejectWrongPassword(res, user, password, client, Responses.Mfa.missingPassword);
};
