import express from "express";
import { get } from "lodash";

import { getUserById } from "../database/users";
import { MfaEmailCode, restoreMfaEmailCode, setMfaEmail, setMfaEmailCode } from "../database/mfa";
import {
    MfaChallengeCookie,
    answerMfaChallengeExpired,
    completeMfaLogin,
    getMfaUser,
    mfaChallengeOf,
    mfaMethods,
    mfaMethodsOn,
    parseMfaToken
} from "../helpers/mfa";
import {
    emailMfa,
    isMfaEmailLinkMatch,
    mfaEmailCodeScope,
    mfaEmailLinkHash,
    mfaEmailPage
} from "../helpers/mfaEmail";
import {
    answerMailBudgetUsedUp,
    answerResendTooSoon,
    createEmailCode,
    issueEmailCode,
    resendAllowedBefore
} from "../helpers/emailCodes";
import { createOauthSecret } from "../helpers/github";
import { MailBudgetError, sendMail } from "../helpers/mail";
import { reauthFields, rejectFailedMfaReauth } from "../helpers/reauth";
import { ipKey } from "../middlewares/rateLimit";
import { MFA_CHALLENGE_MINUTES } from "../constants/limits";
import { Emails } from "../constants/emails";
import { Responses } from "../constants/responses";

export const getMfaChallenge = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const user = await getMfaUser(mfaChallengeOf(req));

        if (!user) {
            return answerMfaChallengeExpired(res);
        }

        return res.status(200).json({ methods: mfaMethodsOn(user.authentication) });
    } catch (error) {
        return next(error);
    }
};

export const verifyMfa = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { method, code } = req.body;
        const challenge: MfaChallengeCookie | null = mfaChallengeOf(req);

        if (!challenge) {
            return answerMfaChallengeExpired(res);
        }

        if (typeof method !== "string" || typeof code !== "string" || !method || !code) {
            return res.status(400).json({ error: Responses.Mfa.missingMethodCode });
        }

        const user = await getMfaUser(challenge);

        if (!user) {
            return answerMfaChallengeExpired(res);
        }

        if (!mfaMethodsOn(user.authentication).includes(method)) {
            return res.status(400).json({ error: Responses.Mfa.methodNotOn });
        }

        return await completeMfaLogin(res, challenge, (claimed) =>
            mfaMethods[method].verify(claimed, req.body)
        );
    } catch (error) {
        return next(error);
    }
};

export const verifyMfaLink = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { token } = req.body;
        const challenge: MfaChallengeCookie | null = mfaChallengeOf(req);

        if (!challenge) {
            return answerMfaChallengeExpired(res);
        }

        if (typeof token !== "string" || !token) {
            return res.status(400).json({ error: Responses.Mfa.missingLinkToken });
        }

        const user = await getMfaUser(challenge);

        if (!user) {
            return answerMfaChallengeExpired(res);
        }

        if (!emailMfa.isOn(user.authentication)) {
            return res.status(400).json({ error: Responses.Mfa.methodNotOn });
        }

        const [id, secret] = parseMfaToken(token);

        return await completeMfaLogin(
            res,
            challenge,
            (claimed) => id === challenge.id && isMfaEmailLinkMatch(claimed, secret),
            Responses.Mfa.invalidLink
        );
    } catch (error) {
        return next(error);
    }
};

export const sendMfaEmail = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const challenge: MfaChallengeCookie | null = mfaChallengeOf(req);
        const user = await getMfaUser(challenge);

        if (!user) {
            return answerMfaChallengeExpired(res);
        }

        if (!emailMfa.isOn(user.authentication)) {
            return res.status(400).json({ error: Responses.Mfa.methodNotOn });
        }

        const code: string = createEmailCode();
        const secret: string = createOauthSecret();
        const { hash, sentAt } = issueEmailCode(
            mfaEmailCodeScope(challenge.id, challenge.hash),
            code,
            MFA_CHALLENGE_MINUTES
        );
        const email: MfaEmailCode = {
            hash,
            linkHash: mfaEmailLinkHash(challenge.id, challenge.hash, secret)
        };
        const previous = await setMfaEmailCode(
            challenge.id,
            challenge.hash,
            email,
            sentAt,
            resendAllowedBefore()
        );

        if (!previous) {
            const current = await getMfaUser(challenge);

            return current
                ? answerResendTooSoon(res, current.authentication.mfaEmailSentAt)
                : answerMfaChallengeExpired(res);
        }

        try {
            await sendMail({
                to: user.email,
                ...Emails.mfaEmailCode(
                    user.username,
                    code,
                    mfaEmailPage(challenge.id, secret),
                    MFA_CHALLENGE_MINUTES
                )
            });
        } catch (error) {
            console.error(error);
            await restoreMfaEmailCode(challenge.id, email, previous.authentication);

            if (error instanceof MailBudgetError) {
                return answerMailBudgetUsedUp(
                    res,
                    Responses.EmailCodes.mailBudgetUsedUpForAccounts
                );
            }

            return res.status(503).json({ error: Responses.EmailCodes.mailFailed });
        }

        return res.status(202).json({ message: Responses.Mfa.emailCodeSent });
    } catch (error) {
        return next(error);
    }
};

const changeEmailMfa =
    (on: boolean) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const userId: string = get(req, "identity._id").toString();
            const user = await getUserById(userId)
                .select(`${reauthFields} +authentication.emailVerifiedAt`)
                .lean();

            if (!user) {
                return res.status(403).json({ error: Responses.notLoggedIn });
            }

            const rejected = await rejectFailedMfaReauth(
                res,
                user,
                req.body.password,
                ipKey(req.ip)
            );
            if (rejected) {
                return rejected;
            }

            if (on && !user.authentication?.emailVerifiedAt) {
                return res.status(409).json({ error: Responses.Mfa.emailNotVerified });
            }

            await setMfaEmail(userId, on);

            return res
                .status(200)
                .json({ message: on ? Responses.Mfa.emailMfaOn : Responses.Mfa.emailMfaOff });
        } catch (error) {
            return next(error);
        }
    };

export const enableEmailMfa = changeEmailMfa(true);

export const disableEmailMfa = changeEmailMfa(false);
