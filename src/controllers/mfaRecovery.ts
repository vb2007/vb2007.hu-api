import express from "express";
import { get } from "lodash";

import { getUserById, reauthedSessionFilter } from "../database/users";
import { mfaMethodsOn } from "../helpers/mfa";
import { issueMfaRecoveryCodes } from "../helpers/mfaRecovery";
import { githubReauthSince, rejectFailedMfaReauth } from "../helpers/reauth";
import { mailSecurityNotice } from "../helpers/securityNotice";
import { sessionCookie } from "../helpers/session";
import { GITHUB_REAUTH_MINUTES } from "../constants/limits";
import { Responses } from "../constants/responses";
import { SecurityChanges } from "../constants/emails";

export const replaceMfaRecoveryCodes = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId);

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const rejected = await rejectFailedMfaReauth(req, res, user);
        if (rejected) {
            return rejected;
        }

        if (mfaMethodsOn(user.authentication).length === 0) {
            return res.status(409).json({ error: Responses.Mfa.noMfaMethodOn });
        }

        const recoveryCodes: string[] | null = await issueMfaRecoveryCodes(
            userId,
            reauthedSessionFilter(
                userId,
                req.cookies[sessionCookie],
                user.authentication?.password,
                githubReauthSince()
            ),
            true
        );

        if (!recoveryCodes) {
            return res.status(403).json({
                error: user.authentication?.password
                    ? Responses.notLoggedIn
                    : Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
            });
        }

        res.status(200).json({ message: Responses.Mfa.recoveryCodesReplaced, recoveryCodes });

        await mailSecurityNotice(user, SecurityChanges.recoveryCodesReplaced);
    } catch (error) {
        return next(error);
    }
};
