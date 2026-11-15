import express from "express";
import { get } from "lodash";

import { getUserById, reauthedSessionFilter } from "../database/users";
import { uncountMfaFailure } from "../database/mfa";
import {
    claimMfaTotpSetupTry,
    countMfaTotpSetupFailure,
    disableMfaTotp,
    enableMfaTotp,
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
import { answerInvalidCode, answerUnclaimedCode } from "../helpers/emailCodes";
import { githubReauthSince, reauthFields, rejectFailedMfaReauth } from "../helpers/reauth";
import { sessionCookie } from "../helpers/session";
import { hashSessionToken } from "../helpers";
import { ipKey } from "../middlewares/rateLimit";
import { GITHUB_REAUTH_MINUTES, MFA_TOTP_SETUP_MINUTES } from "../constants/limits";
import { Responses } from "../constants/responses";

const reauthedUser = async (req: express.Request, res: express.Response) => {
    const userId: string = get(req, "identity._id").toString();
    const user = await getUserById(userId).select(reauthFields).lean();

    if (!user) {
        res.status(403).json({ error: Responses.notLoggedIn });
        return null;
    }

    if (await rejectFailedMfaReauth(res, user, req.body.password, ipKey(req.ip))) {
        return null;
    }

    return {
        userId,
        user,
        reauthed: reauthedSessionFilter(
            userId,
            req.cookies[sessionCookie],
            user.authentication?.password,
            githubReauthSince()
        )
    };
};

const answerReauthLost = (res: express.Response, hasPassword: boolean) =>
    res.status(403).json({
        error: hasPassword
            ? Responses.notLoggedIn
            : Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
    });

export const startTotpSetup = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const found = await reauthedUser(req, res);

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
            return answerReauthLost(res, Boolean(found.user.authentication?.password));
        }

        return res.status(200).json({ secret, otpauthUrl: totpUrl(found.user.username, secret) });
    } catch (error) {
        return next(error);
    }
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

        const userId: string = get(req, "identity._id").toString();
        const sessionToken: string = req.cookies[sessionCookie];
        const claimed = await claimMfaTotpSetupTry(userId, hashSessionToken(sessionToken));
        const setup = claimed?.authentication?.mfaTotpSetup;

        if (!setup) {
            const failures = (await countMfaTotpSetupFailure(userId))?.authentication?.mfaFailures;
            return answerUnclaimedCode(res, failures);
        }

        const secret: string | null = decryptTotpSecret(userId, setup.secret);
        const step: number | null = secret === null ? null : matchingTotpStep(secret, code);

        if (step === null) {
            return answerInvalidCode(res);
        }

        await uncountMfaFailure(userId, claimed.authentication.mfaFailures.since);

        const { matchedCount } = await enableMfaTotp(userId, sessionToken, setup, step);

        if (matchedCount === 0) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res.status(200).json({ message: Responses.Mfa.totpMfaOn });
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
        const found = await reauthedUser(req, res);

        if (!found) {
            return;
        }

        const { matchedCount } = await disableMfaTotp(found.reauthed, totpMfa.storedPaths);

        if (matchedCount === 0) {
            return answerReauthLost(res, Boolean(found.user.authentication?.password));
        }

        return res.status(200).json({ message: Responses.Mfa.totpMfaOff });
    } catch (error) {
        return next(error);
    }
};
