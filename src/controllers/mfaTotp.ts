import express from "express";
import { get } from "lodash";
import { MongoFieldFilter } from "@prisma/orm-mongo/query-ast/execution";

import { activeSessionFilter, getUserBySessionToken } from "../database/users";
import { turnOffMfaMethod } from "../database/mfa";
import {
    claimMfaTotpSetupTry,
    enableMfaTotp,
    getMfaTotpSetup,
    setMfaTotpSetup
} from "../database/mfaTotp";
import {
    createTotpSecret,
    decryptTotpSecret,
    encryptTotpSecret,
    matchingTotpStep,
    totpMfa,
    totpUrl
} from "../helpers/mfaTotp";
import { answerInvalidCode } from "../helpers/emailCodes";
import { dropUnusableMfaRecoveryCodes } from "../helpers/mfa";
import { issueMfaRecoveryCodes } from "../helpers/mfaRecovery";
import { answerMfaReauthLost, reauthedMfaUser } from "../helpers/reauth";
import { sessionCookie } from "../helpers/session";
import { hashSessionToken } from "../helpers";
import { allOf, idIs } from "../helpers/prisma";
import { MFA_TOTP_SETUP_ATTEMPTS, MFA_TOTP_SETUP_MINUTES } from "../constants/limits";
import { Responses } from "../constants/responses";
import { SecurityChanges } from "../constants/emails";
import { mailSecurityNotice } from "../helpers/securityNotice";

export const startTotpSetup = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const found = await reauthedMfaUser(req, res);

        if (!found) {
            return;
        }

        const secret: string = createTotpSecret();
        const { matchedCount } = await setMfaTotpSetup(found.reauthed, {
            secret: encryptTotpSecret(found.userId, secret),
            session: hashSessionToken(req.cookies[sessionCookie]),
            expiresAt: new Date(Date.now() + MFA_TOTP_SETUP_MINUTES * 60 * 1000),
            attempts: 0
        });

        if (matchedCount === 0) {
            return answerMfaReauthLost(res, found.user);
        }

        return res.status(200).json({ secret, otpauthUrl: totpUrl(found.user.username, secret) });
    } catch (error) {
        return next(error);
    }
};

const answerLostSetup = async (res: express.Response, sessionToken: string, secret: string) => {
    const current = await getUserBySessionToken(sessionToken);

    if (!current) {
        return res.status(403).json({ error: Responses.notLoggedIn });
    }

    return current.authentication?.mfaTotpSecret === secret
        ? res.status(200).json({ message: Responses.Mfa.totpMfaOn })
        : answerInvalidCode(res, undefined, { reason: "noSetup" });
};

const totpSetupEndReason = async (userId: string, sessionHash: string): Promise<string> => {
    const setup = (await getMfaTotpSetup(userId, sessionHash))?.authentication?.mfaTotpSetup;

    if (!setup) {
        return "noSetup";
    }

    if (setup.attempts >= MFA_TOTP_SETUP_ATTEMPTS) {
        return "setupTriesUsedUp";
    }

    return setup.expiresAt <= new Date() ? "setupExpired" : "noSetup";
};

export const confirmTotpMfa = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { code } = req.body;

        if (typeof code !== "string" || !code) {
            return res.status(400).json({ error: Responses.Users.missingCode });
        }

        const userId: string = get(req, "identity._id");
        const sessionToken: string = req.cookies[sessionCookie];
        const sessionHash: string = hashSessionToken(sessionToken);
        const claimed = await claimMfaTotpSetupTry(userId, sessionHash);
        const setup = claimed?.authentication?.mfaTotpSetup;

        if (!setup) {
            return res.status(400).json({
                error: Responses.EmailCodes.invalidCode,
                reason: await totpSetupEndReason(userId, sessionHash)
            });
        }

        const secret: string | null = decryptTotpSecret(userId, setup.secret);
        const step: number | null = secret === null ? null : matchingTotpStep(secret, code);

        if (step === null) {
            return answerInvalidCode(res, undefined, {
                attemptsLeft: MFA_TOTP_SETUP_ATTEMPTS - setup.attempts
            });
        }

        const previous = await enableMfaTotp(userId, sessionToken, setup, step);

        if (!previous) {
            return await answerLostSetup(res, sessionToken, setup.secret);
        }

        const recoveryCodes: string[] | null = await issueMfaRecoveryCodes(
            userId,
            allOf(
                idIs(userId),
                activeSessionFilter(sessionToken),
                MongoFieldFilter.eq("authentication.mfaTotpSecret", setup.secret)
            )
        );

        res.status(200).json({
            message: Responses.Mfa.totpMfaOn,
            ...(recoveryCodes && { recoveryCodes })
        });
        await mailSecurityNotice(
            get(req, "identity"),
            previous.authentication?.mfaTotpSecret
                ? SecurityChanges.totpSecretChanged
                : SecurityChanges.totpMfaOn
        );
    } catch (error) {
        return next(error);
    }
};

export const disableTotpMfa = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const found = await reauthedMfaUser(req, res);

        if (!found) {
            return;
        }

        const turnOffIf = async (onlyIfOn: boolean): Promise<boolean> =>
            (
                await turnOffMfaMethod(
                    onlyIfOn ? allOf(found.reauthed, totpMfa.onFilter) : found.reauthed,
                    totpMfa.storedPaths
                )
            ).matchedCount > 0;
        const changed: boolean = await turnOffIf(true);

        if (!changed && !(await turnOffIf(false))) {
            return answerMfaReauthLost(res, found.user);
        }

        await dropUnusableMfaRecoveryCodes(found.userId);
        res.status(200).json({ message: Responses.Mfa.totpMfaOff });

        if (changed) {
            await mailSecurityNotice(found.user, SecurityChanges.totpMfaOff);
        }
    } catch (error) {
        return next(error);
    }
};
