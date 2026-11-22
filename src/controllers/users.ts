import express from "express";
import { get } from "lodash";
import { ObjectId } from "@prisma/orm-mongo/bson";

import {
    EmailChange,
    applyEmailChange,
    changePasswordAndSession,
    claimEmailChangeCode,
    claimGithubVerification,
    clearEmailChange,
    countEmailChangeFailure,
    deleteUserById,
    emailChangeScope,
    getUserByEmail,
    getUserById,
    getUserBySessionToken,
    renameUser,
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
    answerMailBudgetUsedUp,
    answerResendTooSoon,
    answerUnclaimedCode,
    createEmailCode,
    isEmailCodeMatch,
    issueEmailCode,
    normalizeEmailCode,
    resendAllowedBefore
} from "../helpers/emailCodes";
import { toAccountStatus } from "../helpers/accountStatus";
import { emailDomainError } from "../helpers/emailDomain";
import { answerRejectedCredential, hashPassword, verifyPassword } from "../helpers/password";
import { MailBudgetError, sendMail } from "../helpers/mail";
import { removeUserContent } from "../helpers/userContent";
import { isDuplicateKeyError } from "../helpers/prisma";
import { isUsernameTaken, usernameFormatError } from "../helpers/username";
import { endSession, sessionCookie, startSession, startSessionWith } from "../helpers/session";
import { githubReauthSince, isGithubVerifiedSince } from "../helpers/reauth";
import { ipKey } from "../middlewares/rateLimit";

export const getUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const currentUser = await getUserById(get(req, "identity._id"));
        if (!currentUser) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const { _id, username, email, githubId, githubLogin, createdAt } = currentUser;

        return res.status(200).json({
            _id,
            username,
            email,
            ...(githubId !== undefined && { githubId }),
            ...(githubLogin !== undefined && { githubLogin }),
            createdAt: createdAt ?? new ObjectId(_id).getTimestamp(),
            ...toAccountStatus(currentUser.authentication),
            isSuperuser: isSuperuserEmail(email)
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

        const usernameError: string | null = usernameFormatError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        if (await isUsernameTaken(username, id)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const { matchedCount } = await renameUser(id, username);

        if (matchedCount === 0) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res.status(200).json({ message: Responses.Users.userUpdatedSuccess });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
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
        const user = await getUserById(userId);

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
            const current = await getUserBySessionToken(req.cookies[sessionCookie]);

            if (!current) {
                return res.status(403).json({ error: Responses.notLoggedIn });
            }

            return current.authentication?.password
                ? res.status(409).json({ error: Responses.Users.passwordAlreadySet })
                : res
                      .status(403)
                      .json({ error: Responses.Users.githubReauthRequired(GITHUB_REAUTH_MINUTES) });
        }

        if (!(await startSession(res, userId))) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res.status(200).json({ message: Responses.Users.passwordSetSuccess });
    } catch (error) {
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
        const user = await getUserById(userId);

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (!user.authentication?.password) {
            return res.status(409).json({ error: Responses.Users.noPasswordToChange });
        }

        const client: string = ipKey(req.ip);
        if (
            !(await verifyPassword(
                user.authentication.salt,
                user.authentication.password,
                currentPassword,
                client
            ))
        ) {
            return answerRejectedCredential(res, Responses.Authentication.incorrectPassword);
        }

        const salt: string = random();
        const password: string = await hashPassword(salt, newPassword, client);
        const changed: boolean = await startSessionWith(res, userId, (session) =>
            changePasswordAndSession(userId, salt, password, session)
        );

        if (!changed) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res.status(200).json({ message: Responses.Users.passwordChangedSuccess });
    } catch (error) {
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

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId);

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
            return answerRejectedCredential(res, Responses.Authentication.incorrectPassword);
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
        const sessionToken: string = req.cookies[sessionCookie];
        const previous = await setEmailChange(
            userId,
            sessionToken,
            user.authentication.password,
            change,
            resendAllowedBefore()
        );

        if (!previous) {
            const current = await getUserBySessionToken(sessionToken);

            if (current?.authentication?.password !== user.authentication.password) {
                return res.status(403).json({ error: Responses.notLoggedIn });
            }

            return answerResendTooSoon(res, current.authentication.emailChange?.sentAt);
        }

        try {
            await sendMail({
                to: normalizedEmail,
                ...Emails.emailChangeCode(user.username, code, EMAIL_CHANGE_CODE_MINUTES)
            });
        } catch (error) {
            console.error(error);
            await restoreEmailChange(userId, change, previous.authentication?.emailChange);

            if (error instanceof MailBudgetError) {
                return answerMailBudgetUsedUp(
                    res,
                    Responses.EmailCodes.mailBudgetUsedUpForAccounts
                );
            }

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

        const userId: string = get(req, "identity._id");
        const user = await claimEmailChangeCode(userId);
        const change = user?.authentication?.emailChange;

        if (!change) {
            const failures = (await countEmailChangeFailure(userId))?.authentication
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
        const user = await getUserBySessionToken(sessionToken);

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        const userId: string = user._id;

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
                return answerRejectedCredential(res, Responses.Authentication.incorrectPassword);
            }
        } else {
            if (typeof username !== "string" || !username) {
                return res.status(400).json({ error: Responses.Users.missingDeleteUsername });
            }

            if (username !== user.username) {
                return answerRejectedCredential(res, Responses.Users.incorrectDeleteUsername);
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

            const { matchedCount } = await claimGithubVerification(
                userId,
                sessionToken,
                githubVerifiedSince
            );

            if (matchedCount === 0) {
                return res.status(403).json(reauthRequired);
            }
        }

        await removeUserContent(userId);
        await deleteUserById(userId);
        await removeUserContent(userId);
        await endSession(res, null);

        return res.status(200).json({ message: Responses.Users.userDeletedSuccess });
    } catch (error) {
        return next(error);
    }
};
