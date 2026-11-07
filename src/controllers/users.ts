import express from "express";
import { get } from "lodash";

import {
    EmailChange,
    applyEmailChange,
    claimEmailChangeCode,
    clearEmailChange,
    deleteGithubVerifiedUser,
    deleteUserById,
    emailChangeScope,
    getEmailChange,
    getEmailChangeFailures,
    getUserByEmail,
    getUserById,
    getUserBySessionToken,
    restoreEmailChange,
    setEmailChange,
    setPasswordIfUnset,
    uncountEmailChangeFailure
} from "../database/users";
import { EMAIL_CHANGE_CODE_MINUTES, GITHUB_REAUTH_MINUTES } from "../constants/limits";
import { Emails } from "../constants/emails";
import { Responses } from "../constants/responses";
import {
    isSuperuserEmail,
    isValidEmail,
    normalizeEmail,
    random,
    passwordLengthError
} from "../helpers";
import {
    answerInvalidCode,
    answerResendTooSoon,
    answerUnclaimedCode,
    createEmailCode,
    isEmailCodeMatch,
    issueEmailCode,
    normalizeEmailCode,
    resendAllowedBefore
} from "../helpers/emailCodes";
import { accountStatusFields, toAccountStatus } from "../helpers/accountStatus";
import { emailDomainError } from "../helpers/emailDomain";
import { hashPassword, verifyPassword } from "../helpers/password";
import { sendMail } from "../helpers/mail";
import { removeUserContent } from "../helpers/userContent";
import { isDocumentNotFoundError, isDuplicateKeyError } from "../helpers/mongoose";
import { isUsernameTaken, usernameLengthError } from "../helpers/username";
import { endSession, sessionCookie, startSession } from "../helpers/session";
import { ipKey } from "../middlewares/rateLimit";

const githubReauthSince = (): Date => new Date(Date.now() - GITHUB_REAUTH_MINUTES * 60 * 1000);

const isGithubVerifiedSince = (verifiedAt: Date | undefined, since: Date): boolean =>
    Boolean(verifiedAt) && verifiedAt >= since && verifiedAt <= new Date();

export const getUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const sessionToken: string = req.cookies[sessionCookie];
        const currentUser = await getUserBySessionToken(sessionToken).select(accountStatusFields);
        if (!currentUser) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const { authentication, suspendedAt, ...user } = currentUser.toObject({
            versionKey: false
        });

        return res.status(200).json({
            ...user,
            ...toAccountStatus(authentication),
            isSuperuser: isSuperuserEmail(currentUser.email)
        });
    } catch (error) {
        return next(error);
    }
};

export const updateUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { id } = req.params;
        const { username } = req.body;

        if (typeof username !== "string" || !username) {
            return res.status(400).json({ error: Responses.Users.missingUsername });
        }

        const usernameError: string | null = usernameLengthError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        if (await isUsernameTaken(username, id)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const user = await getUserById(id);

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        user.username = username;
        await user.save();

        return res.status(200).json({ message: Responses.Users.userUpdatedSuccess });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        if (isDocumentNotFoundError(error)) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return next(error);
    }
};

export const setPassword = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { password } = req.body;

        if (typeof password !== "string" || !password) {
            return res.status(400).json({ error: Responses.Users.missingPassword });
        }

        const passwordError: string | null = passwordLengthError(password);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select(
            "+authentication.password +authentication.githubVerifiedAt"
        );

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (user.authentication?.password) {
            return res.status(409).json({ error: Responses.Users.passwordAlreadySet });
        }

        const githubVerifiedSince: Date = githubReauthSince();

        if (!isGithubVerifiedSince(user.authentication?.githubVerifiedAt, githubVerifiedSince)) {
            return res
                .status(403)
                .json({ error: Responses.Users.githubReauthRequired(GITHUB_REAUTH_MINUTES) });
        }

        const salt: string = random();
        const { matchedCount } = await setPasswordIfUnset(
            userId,
            req.cookies[sessionCookie],
            salt,
            await hashPassword(salt, password, ipKey(req.ip)),
            githubVerifiedSince
        );

        if (matchedCount === 0) {
            return res.status(409).json({ error: Responses.Users.passwordAlreadySet });
        }

        await startSession(res, user);

        return res.status(200).json({ message: Responses.Users.passwordSetSuccess });
    } catch (error) {
        if (isDocumentNotFoundError(error)) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return next(error);
    }
};

export const changePassword = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (
            typeof currentPassword !== "string" ||
            typeof newPassword !== "string" ||
            !currentPassword ||
            !newPassword
        ) {
            return res.status(400).json({ error: Responses.Users.missingPasswords });
        }

        const passwordError: string | null = passwordLengthError(newPassword);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password"
        );

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (!user.authentication?.password) {
            return res.status(409).json({ error: Responses.Users.noPasswordToChange });
        }

        if (
            !(await verifyPassword(
                user.authentication.salt,
                user.authentication.password,
                currentPassword,
                ipKey(req.ip)
            ))
        ) {
            return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
        }

        const salt: string = random();
        user.authentication.salt = salt;
        user.authentication.password = await hashPassword(salt, newPassword, ipKey(req.ip));
        user.authentication.passwordReset = undefined;
        user.authentication.passwordResetLinks = undefined;
        await startSession(res, user);

        return res.status(200).json({ message: Responses.Users.passwordChangedSuccess });
    } catch (error) {
        if (isDocumentNotFoundError(error)) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return next(error);
    }
};

export const changeEmail = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { email, password } = req.body;

        if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
            return res.status(400).json({ error: Responses.Authentication.missingEmailPassword });
        }

        const normalizedEmail: string = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json({ error: Responses.Authentication.invalidEmailFormat });
        }

        const userId: string = get(req, "identity._id").toString();
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password"
        );

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (isSuperuserEmail(user.email)) {
            return res.status(403).json({ error: Responses.Users.superuserEmailChange });
        }

        if (!user.authentication?.password) {
            return res.status(409).json({ error: Responses.Users.noPasswordToChangeEmail });
        }

        if (
            !(await verifyPassword(
                user.authentication.salt,
                user.authentication.password,
                password,
                ipKey(req.ip)
            ))
        ) {
            return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
        }

        if (normalizedEmail === user.email) {
            return res.status(200).json({ message: Responses.Users.emailUpdatedSuccess });
        }

        const domainError: string | null = await emailDomainError(normalizedEmail);
        if (domainError) {
            return res.status(400).json({ error: domainError });
        }

        const code: string = createEmailCode();
        const change: EmailChange = {
            email: normalizedEmail,
            ...issueEmailCode(
                emailChangeScope(userId, normalizedEmail),
                code,
                EMAIL_CHANGE_CODE_MINUTES
            )
        };
        const previous = await setEmailChange(userId, change, resendAllowedBefore());

        if (!previous) {
            const pending = await getEmailChange(userId);
            return answerResendTooSoon(res, pending?.authentication?.emailChange?.sentAt);
        }

        try {
            await sendMail({
                to: normalizedEmail,
                ...Emails.emailChangeCode(user.username, code, EMAIL_CHANGE_CODE_MINUTES)
            });
        } catch (error) {
            console.error(error);
            await restoreEmailChange(userId, change, previous.authentication?.emailChange);
            return res.status(503).json({ error: Responses.EmailCodes.mailFailed });
        }

        return res
            .status(202)
            .json({ message: Responses.Users.emailChangeCodeSent(normalizedEmail) });
    } catch (error) {
        return next(error);
    }
};

export const confirmEmailChange = async (
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
        const user = await claimEmailChangeCode(userId);
        const change = user?.authentication?.emailChange;

        if (!change) {
            const failures = (await getEmailChangeFailures(userId))?.authentication
                ?.emailChangeFailures;
            return answerUnclaimedCode(res, failures);
        }

        if (
            !isEmailCodeMatch(
                change.hash,
                emailChangeScope(userId, change.email),
                normalizeEmailCode(code)
            )
        ) {
            return answerInvalidCode(res);
        }

        await uncountEmailChangeFailure(userId, user.authentication.emailChangeFailures.since);

        if (isSuperuserEmail(change.email)) {
            await clearEmailChange(userId);
            return res.status(403).json({ error: Responses.Users.emailReservedForSuperuser });
        }

        if (await getUserByEmail(change.email)) {
            await clearEmailChange(userId);
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        const { matchedCount } = await applyEmailChange(userId, change.hash, change.email);

        if (matchedCount === 0) {
            return answerInvalidCode(res);
        }

        try {
            await sendMail({ to: user.email, ...Emails.emailChanged(user.username, change.email) });
        } catch (error) {
            console.error(error);
        }

        return res.status(200).json({ message: Responses.Users.emailUpdatedSuccess });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        return next(error);
    }
};

export const deleteUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { password, username } = req.body;

        const sessionToken: string = req.cookies[sessionCookie];
        const user = await getUserBySessionToken(sessionToken).select(
            "+authentication.salt +authentication.password +authentication.githubVerifiedAt"
        );

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const userId: string = user._id.toString();

        if (user.authentication?.password) {
            if (typeof password !== "string" || !password) {
                return res.status(400).json({ error: Responses.Users.missingDeletePassword });
            }

            if (
                !(await verifyPassword(
                    user.authentication.salt,
                    user.authentication.password,
                    password,
                    ipKey(req.ip)
                ))
            ) {
                return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
            }

            await removeUserContent(userId);
            await deleteUserById(userId);
        } else {
            if (typeof username !== "string" || !username) {
                return res.status(400).json({ error: Responses.Users.missingDeleteUsername });
            }

            if (username !== user.username) {
                return res.status(403).json({ error: Responses.Users.incorrectDeleteUsername });
            }

            const githubVerifiedSince: Date = githubReauthSince();
            const reauthRequired = {
                error: Responses.Users.githubReauthRequiredToDelete(GITHUB_REAUTH_MINUTES)
            };

            if (
                !isGithubVerifiedSince(user.authentication?.githubVerifiedAt, githubVerifiedSince)
            ) {
                return res.status(403).json(reauthRequired);
            }

            await removeUserContent(userId);
            const { deletedCount } = await deleteGithubVerifiedUser(
                userId,
                sessionToken,
                githubVerifiedSince
            );

            if (deletedCount === 0) {
                return res.status(403).json(reauthRequired);
            }
        }

        await removeUserContent(userId);
        await endSession(res, null);

        return res.status(200).json({ message: Responses.Users.userDeletedSuccess });
    } catch (error) {
        return next(error);
    }
};
