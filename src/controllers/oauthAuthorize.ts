import express from "express";
import { get, isPlainObject, pick } from "lodash";

import { getUserById } from "../database/users";
import { claimOauthCode, saveOauthCode } from "../database/oauthCodes";
import { Responses } from "../constants/responses";
import { OAUTH_CODE_SECONDS } from "../constants/limits";
import { hashSessionToken, isSuperuserEmail } from "../helpers";
import { createOauthSecret } from "../helpers/github";
import { findClient } from "../helpers/oauthClients";
import {
    authorizeParams,
    authorizeRequestError,
    authorizeTargetOf,
    isParam,
    verifierMatches,
    withQuery
} from "../helpers/oauthAuthorize";

const authorizePage: string = `${process.env.BASE_SITE_URL || "https://vb2007.hu"}/authorize`;

const bodyOf = (req: express.Request): Record<string, unknown> =>
    isPlainObject(req.body) ? req.body : {};

export const getOauthClient = (req: express.Request, res: express.Response) => {
    const client = findClient(req.params.clientId);

    if (!client?.redirectUris.length) {
        return res.status(404).json({ error: Responses.OAuth.clientNotFound });
    }

    return res.status(200).json({ id: client.id, name: client.name });
};

export const startAuthorization = (req: express.Request, res: express.Response) => {
    const target = authorizeTargetOf(req.query);

    if ("error" in target) {
        return res.redirect(302, withQuery(authorizePage, { error: target.error }));
    }

    const error = authorizeRequestError(req.query);

    if (error) {
        const { state } = req.query;

        return res.redirect(
            302,
            withQuery(target.redirectUri, { error, ...(isParam(state) && { state }) })
        );
    }

    return res.redirect(
        302,
        withQuery(authorizePage, pick(req.query, authorizeParams) as Record<string, string>)
    );
};

export const authorize = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const body: Record<string, unknown> = bodyOf(req);
        const target = authorizeTargetOf(body);

        if ("error" in target) {
            return res.status(400).json({
                error:
                    target.error === "invalid_client"
                        ? Responses.OAuth.unknownClient
                        : Responses.OAuth.redirectUriNotAllowed
            });
        }

        if (authorizeRequestError(body) || typeof body.approve !== "boolean") {
            return res.status(400).json({ error: Responses.OAuth.invalidAuthorizeRequest });
        }

        const state: string = body.state as string;

        if (!body.approve) {
            return res.status(200).json({
                redirectTo: withQuery(target.redirectUri, { error: "access_denied", state })
            });
        }

        const code: string = createOauthSecret();

        await saveOauthCode(hashSessionToken(code), {
            clientId: target.client.id,
            redirectUri: target.redirectUri,
            codeChallenge: body.code_challenge as string,
            nonce: body.nonce as string,
            userId: get(req, "identity._id"),
            expiresAt: new Date(Date.now() + OAUTH_CODE_SECONDS * 1000)
        });

        return res.status(200).json({ redirectTo: withQuery(target.redirectUri, { code, state }) });
    } catch (error) {
        return next(error);
    }
};

const answerTokenError = (res: express.Response, error: string, description: string) =>
    res.status(400).json({ error, error_description: description });

export const exchangeCode = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { grant_type, code, redirect_uri, code_verifier } = bodyOf(req);

        if (typeof grant_type === "string" && grant_type !== "authorization_code") {
            return answerTokenError(
                res,
                "unsupported_grant_type",
                Responses.OAuth.unsupportedGrantType
            );
        }

        if (
            grant_type !== "authorization_code" ||
            typeof code !== "string" ||
            typeof redirect_uri !== "string" ||
            typeof code_verifier !== "string"
        ) {
            return answerTokenError(res, "invalid_request", Responses.OAuth.invalidTokenRequest);
        }

        const stored = await claimOauthCode(hashSessionToken(code));

        if (!stored || stored.clientId !== req.oauthClient.id) {
            return answerTokenError(res, "invalid_grant", Responses.OAuth.invalidCode);
        }

        if (
            stored.redirectUri !== redirect_uri ||
            !verifierMatches(stored.codeChallenge, code_verifier)
        ) {
            return answerTokenError(res, "invalid_grant", Responses.OAuth.codeMismatch);
        }

        const user = await getUserById(String(stored.userId));

        if (!user || user.suspendedAt) {
            return answerTokenError(res, "invalid_grant", Responses.OAuth.accountUnavailable);
        }

        return res.status(200).json({
            sub: user._id,
            email: user.email,
            email_verified: Boolean(user.authentication?.emailVerifiedAt),
            username: user.username,
            isSuperuser: isSuperuserEmail(user.email),
            nonce: stored.nonce
        });
    } catch (error) {
        return next(error);
    }
};
