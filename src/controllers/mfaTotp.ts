import express from "express";
import { get } from "lodash";

import { getUserBySessionToken } from "../database/users";
import { turnOffMfaMethod, uncountMfaFailure } from "../database/mfa";
import {
    claimMfaTotpSetupTry,
    countMfaTotpSetupFailure,
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
import { answerMfaReauthLost, reauthedMfaUser } from "../helpers/reauth";
import { sessionCookie } from "../helpers/session";
import { hashSessionToken } from "../helpers";
import { MFA_TOTP_SETUP_MINUTES } from "../constants/limits";
import { Responses } from "../constants/responses";

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
    const current = await getUserBySessionToken(sessionToken)
        .select("+authentication.mfaTotpSecret")
        .lean();

    if (!current) {
        return res.status(403).json({ error: Responses.notLoggedIn });
    }

    return current.authentication?.mfaTotpSecret === secret
        ? res.status(200).json({ message: Responses.Mfa.totpMfaOn })
        : answerInvalidCode(res);
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
            return await answerLostSetup(res, sessionToken, setup.secret);
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
        const found = await reauthedMfaUser(req, res);

        if (!found) {
            return;
        }

        const { matchedCount } = await turnOffMfaMethod(found.reauthed, totpMfa.storedPaths);

        if (matchedCount === 0) {
            return answerMfaReauthLost(res, found.user);
        }

        return res.status(200).json({ message: Responses.Mfa.totpMfaOff });
    } catch (error) {
        return next(error);
    }
};
