import express from "express";
import { get } from "lodash";

import {
    ExpiringHash,
    claimGithubLinkProof,
    claimPasswordResetCode,
    countPasswordResetFailure,
    createUser,
    getUserByEmail,
    getUserByGithubId,
    getUserById,
    hasPasswordResetLink,
    isEmailSuspended,
    linkGithubAccount,
    loginGithubAccount,
    passwordResetLinkScope,
    passwordResetScope,
    replacePasswordHash,
    resetPassword,
    resetPasswordWithLink,
    restorePasswordReset,
    setGithubLinkProof,
    setPasswordReset
} from "../database/users";
import {
    StoredPendingRegistration,
    claimPendingRegistrationCode,
    countPendingRegistrationFailure,
    deletePendingRegistration,
    getPendingRegistration,
    registrationCodeScope,
    reinstatePendingRegistration,
    replacePendingRegistrationCode,
    restorePendingRegistration,
    restorePendingRegistrationCode,
    savePendingRegistration,
    takePendingRegistration,
    uncountPendingRegistrationFailure
} from "../database/pendingRegistrations";
import {
    authentication,
    isValidEmail,
    normalizeEmail,
    random,
    passwordLengthError
} from "../helpers";
import { trackPendingWork } from "../helpers/pendingWork";
import { rememberDevice } from "../helpers/deviceCookie";
import {
    hashPassword,
    isLegacyPasswordHash,
    verifyLoginPassword,
    verifyPassword
} from "../helpers/password";
import {
    GithubProfile,
    buildAuthorizeUrl,
    createOauthSecret,
    deriveUsername,
    exchangeCode,
    fetchGithubProfile,
    isGithubConfigured
} from "../helpers/github";
import {
    EmailCode,
    answerInvalidCode,
    answerUnclaimedCode,
    createEmailCode,
    isEmailCodeMatch,
    issueEmailCode,
    normalizeEmailCode,
    answerResendTooSoon,
    resendAllowedBefore
} from "../helpers/emailCodes";
import { emailDomainError } from "../helpers/emailDomain";
import { MailReservation, reserveRegistrationMail, sendMail } from "../helpers/mail";
import { isDocumentNotFoundError, isDuplicateKeyError } from "../helpers/mongoose";
import {
    UserDocument,
    endSession,
    getSessionUser,
    sessionCookie,
    startSessionIfPresent,
    startSessionWith
} from "../helpers/session";
import { isUsernameTaken, usernameFormatError } from "../helpers/username";
import { ipKey } from "../middlewares/rateLimit";
import {
    EMAIL_CODE_RESEND_SECONDS,
    GITHUB_OAUTH_MINUTES,
    GITHUB_SIGN_UP_ATTEMPTS,
    PASSWORD_RESET_CODE_MINUTES,
    PENDING_REGISTRATION_HOURS,
    REGISTRATION_CODE_MINUTES
} from "../constants/limits";
import { Emails } from "../constants/emails";
import { Responses } from "../constants/responses";

import dotenv from "dotenv";
dotenv.config();

const upgradeLegacyPasswordHash = async (
    user: UserDocument,
    password: string,
    client: string
): Promise<void> => {
    const salt: string = random();

    await replacePasswordHash(
        user._id.toString(),
        user.authentication.password,
        salt,
        await hashPassword(salt, password, client)
    );
};

export const login = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail: string = typeof email === "string" ? normalizeEmail(email) : "";

        if (!normalizedEmail || typeof password !== "string" || !password) {
            return res.status(400).json({ error: Responses.Authentication.missingEmailPassword });
        }

        const user = await getUserByEmail(normalizedEmail).select(
            "+authentication.salt +authentication.password"
        );

        const client: string = ipKey(req.ip);
        const isPasswordCorrect: boolean = await verifyLoginPassword(
            user?.authentication.salt,
            user?.authentication.password,
            password,
            client
        );

        if (!user || !isPasswordCorrect) {
            return res.status(403).json({ error: Responses.Authentication.invalidCredentials });
        }

        if (user.suspendedAt) {
            return res.status(403).json({ error: Responses.Authentication.accountSuspended });
        }

        if (isLegacyPasswordHash(user.authentication.password)) {
            await upgradeLegacyPasswordHash(user, password, client);
        }

        if (!(await startSessionIfPresent(res, user))) {
            return res.status(403).json({ error: Responses.Authentication.invalidCredentials });
        }

        rememberDevice(res, user);

        return res
            .status(200)
            .json({ message: Responses.Authentication.loginSuccess(user.username) });
    } catch (error) {
        return next(error);
    }
};

export const logout = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const user = await getSessionUser(req);

        await endSession(res, user);

        return res.status(200).json({ message: Responses.Authentication.logoutSuccess });
    } catch (error) {
        return next(error);
    }
};

const issueRegistrationCode = (email: string, code: string): EmailCode =>
    issueEmailCode(registrationCodeScope(email), code, REGISTRATION_CODE_MINUTES);

const mailRegistrationCode = async (
    email: string,
    code: string,
    restore: () => Promise<unknown>,
    reservation?: MailReservation
): Promise<boolean> => {
    try {
        await sendMail(
            {
                to: email,
                ...Emails.registrationCode(code, REGISTRATION_CODE_MINUTES),
                registration: true
            },
            reservation
        );
        return true;
    } catch (error) {
        console.error("Registration code e-mail not sent:", error);
        await restore();
        return false;
    }
};

export const register = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { username, email, password } = req.body;

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            typeof username !== "string" ||
            !email ||
            !password ||
            !username
        ) {
            return res
                .status(400)
                .json({ error: Responses.Authentication.missingEmailPasswordUsername });
        }

        const usernameError: string | null = usernameFormatError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        const passwordError: string | null = passwordLengthError(password);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const normalizedEmail: string = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json({ error: Responses.Authentication.invalidEmailFormat });
        }

        if (await isUsernameTaken(username)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const domainError: string | null = await emailDomainError(normalizedEmail);
        if (domainError) {
            return res.status(400).json({ error: domainError });
        }

        const code: string = createEmailCode();
        const registrationCode: EmailCode = issueRegistrationCode(normalizedEmail, code);
        let previous: StoredPendingRegistration;

        try {
            previous = await savePendingRegistration(
                {
                    email: normalizedEmail,
                    code: registrationCode,
                    expiresAt: new Date(Date.now() + PENDING_REGISTRATION_HOURS * 60 * 60 * 1000)
                },
                resendAllowedBefore()
            );
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                const pending = await getPendingRegistration(normalizedEmail);
                return answerResendTooSoon(res, pending?.code?.sentAt);
            }

            throw error;
        }

        const mailed: boolean = await mailRegistrationCode(normalizedEmail, code, () =>
            restorePendingRegistration(normalizedEmail, registrationCode, previous).exec()
        );

        if (!mailed) {
            return res.status(503).json({ error: Responses.EmailCodes.mailFailed });
        }

        return res
            .status(202)
            .json({ message: Responses.Authentication.registrationCodeSent(normalizedEmail) });
    } catch (error) {
        return next(error);
    }
};

export const checkUsernameAvailable = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const username: string = typeof req.query.username === "string" ? req.query.username : "";

        const usernameError: string | null = usernameFormatError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        return res.status(200).json({ available: !(await isUsernameTaken(username)) });
    } catch (error) {
        return next(error);
    }
};

const mailPendingRegistrationCode = async (
    email: string,
    reservation: MailReservation
): Promise<void> => {
    const code: string = createEmailCode();
    const registrationCode: EmailCode = issueRegistrationCode(email, code);
    const previous = await replacePendingRegistrationCode(
        email,
        registrationCode,
        resendAllowedBefore()
    );

    if (!previous || (await isEmailSuspended(email))) {
        return;
    }

    await mailRegistrationCode(
        email,
        code,
        () => restorePendingRegistrationCode(email, registrationCode, previous.code).exec(),
        reservation
    );
};

export const resendRegistrationCode = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { email } = req.body;

        const normalizedEmail: string = typeof email === "string" ? normalizeEmail(email) : "";

        if (!normalizedEmail) {
            return res.status(400).json({ error: Responses.Authentication.missingEmail });
        }

        const reservation: MailReservation | null = reserveRegistrationMail(normalizedEmail);
        if (!reservation) {
            return res.status(503).json({ error: Responses.EmailCodes.mailFailed });
        }

        res.status(200).json({ message: Responses.Authentication.registrationCodeResent });

        await trackPendingWork(
            mailPendingRegistrationCode(normalizedEmail, reservation).catch(
                (error: unknown): void => console.error("Registration code not resent:", error)
            )
        );
    } catch (error) {
        return next(error);
    }
};

export const verifyRegistration = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { email, code, username, password } = req.body;

        if (
            typeof email !== "string" ||
            typeof code !== "string" ||
            typeof username !== "string" ||
            typeof password !== "string" ||
            !email ||
            !code ||
            !username ||
            !password
        ) {
            return res
                .status(400)
                .json({ error: Responses.Authentication.missingEmailCodeUsernamePassword });
        }

        const usernameError: string | null = usernameFormatError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        const passwordError: string | null = passwordLengthError(password);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const normalizedEmail: string = normalizeEmail(email);
        const pending = await claimPendingRegistrationCode(normalizedEmail);

        if (!pending) {
            return answerUnclaimedCode(
                res,
                (await countPendingRegistrationFailure(normalizedEmail))?.failures
            );
        }

        if (
            !isEmailCodeMatch(
                pending.code.hash,
                registrationCodeScope(normalizedEmail),
                normalizeEmailCode(code)
            )
        ) {
            return answerInvalidCode(res);
        }

        await uncountPendingRegistrationFailure(normalizedEmail, pending.failures.since);

        if (await getUserByEmail(normalizedEmail)) {
            await deletePendingRegistration(normalizedEmail);
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        if (await isUsernameTaken(username)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const salt: string = random();
        const hashedPassword: string = await hashPassword(salt, password, ipKey(req.ip));
        const taken = await takePendingRegistration(normalizedEmail, pending.code);

        if (!taken) {
            return answerInvalidCode(res);
        }

        const user = await createUser({
            username,
            email: normalizedEmail,
            authentication: {
                salt,
                password: hashedPassword,
                emailVerifiedAt: new Date()
            }
        }).catch(async (error: unknown) => {
            await reinstatePendingRegistration(taken);
            throw error;
        });

        if (!(await startSessionIfPresent(res, await getUserById(user._id.toString())))) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return res
            .status(201)
            .json({ message: Responses.Authentication.registrationSuccess(user.username) });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return res.status(409).json({
                error: get(error, "keyPattern.email")
                    ? Responses.Authentication.emailAlreadyExists
                    : Responses.Authentication.usernameTaken
            });
        }

        return next(error);
    }
};

const passwordResetLinksKept: number =
    (PASSWORD_RESET_CODE_MINUTES * 60) / EMAIL_CODE_RESEND_SECONDS;
const passwordResetTokenPattern: RegExp = /^([0-9a-f]{24})\.([\w-]{43})$/;
const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

const passwordResetLinkHash = (id: string, secret: string): string =>
    authentication(passwordResetLinkScope(id), secret);

const passwordResetPage = (id: string, secret: string): string =>
    `${baseSiteUrl}/reset-password#token=${id}.${secret}`;

const mailPasswordChanged = async (user: { email: string; username: string }): Promise<void> => {
    try {
        await sendMail({ to: user.email, ...Emails.passwordChanged(user.username) });
    } catch (error) {
        console.error(error);
    }
};

const mailPasswordReset = async (
    userId: string,
    user: { email: string; username: string }
): Promise<void> => {
    const code: string = createEmailCode();
    const secret: string = createOauthSecret();
    const resetCode: EmailCode = issueEmailCode(
        passwordResetScope(userId, user.email),
        code,
        PASSWORD_RESET_CODE_MINUTES
    );
    const resetLink: ExpiringHash = {
        hash: passwordResetLinkHash(userId, secret),
        expiresAt: resetCode.expiresAt
    };

    const previous = await setPasswordReset(
        userId,
        user.email,
        resetCode,
        resetLink,
        passwordResetLinksKept,
        resendAllowedBefore()
    );

    if (!previous) {
        return;
    }

    try {
        await sendMail({
            to: user.email,
            ...Emails.passwordResetCode(
                user.username,
                code,
                passwordResetPage(userId, secret),
                PASSWORD_RESET_CODE_MINUTES
            ),
            passwordReset: true
        });
    } catch (error) {
        console.error("Password reset e-mail not sent:", error);
        await restorePasswordReset(
            userId,
            resetCode,
            resetLink,
            previous.authentication?.passwordReset
        );
    }
};

export const requestPasswordReset = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { email } = req.body;

        const normalizedEmail: string = typeof email === "string" ? normalizeEmail(email) : "";

        if (!normalizedEmail) {
            return res.status(400).json({ error: Responses.Authentication.missingEmail });
        }

        const user = await getUserByEmail(normalizedEmail);

        res.status(200).json({ message: Responses.Authentication.passwordResetSent });

        if (user && !user.suspendedAt) {
            await trackPendingWork(
                mailPasswordReset(user._id.toString(), user).catch((error: unknown): void =>
                    console.error("Password reset not stored:", error)
                )
            );
        }
    } catch (error) {
        return next(error);
    }
};

export const confirmPasswordReset = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { email, code, newPassword } = req.body;

        if (
            typeof email !== "string" ||
            typeof code !== "string" ||
            typeof newPassword !== "string" ||
            !email ||
            !code ||
            !newPassword
        ) {
            return res
                .status(400)
                .json({ error: Responses.Authentication.missingPasswordResetFields });
        }

        const passwordError: string | null = passwordLengthError(newPassword);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const normalizedEmail: string = normalizeEmail(email);
        const user = await claimPasswordResetCode(normalizedEmail);
        const userId: string | undefined = user?._id.toString();
        const codeHash: string | undefined = user?.authentication?.passwordReset?.hash;

        if (!codeHash) {
            answerInvalidCode(res);
            await trackPendingWork(
                countPasswordResetFailure(normalizedEmail).catch((error: unknown): void =>
                    console.error("Password reset failure not counted:", error)
                )
            );
            return;
        }

        if (
            !isEmailCodeMatch(
                codeHash,
                passwordResetScope(userId, user.email),
                normalizeEmailCode(code)
            )
        ) {
            return answerInvalidCode(res);
        }

        const salt: string = random();
        const { matchedCount } = await resetPassword(
            userId,
            codeHash,
            salt,
            await hashPassword(salt, newPassword, ipKey(req.ip))
        );

        if (matchedCount === 0) {
            return answerInvalidCode(res);
        }

        await mailPasswordChanged(user);

        return res.status(200).json({ message: Responses.Authentication.passwordResetSuccess });
    } catch (error) {
        return next(error);
    }
};

export const confirmPasswordResetLink = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { token, newPassword } = req.body;

        if (
            typeof token !== "string" ||
            typeof newPassword !== "string" ||
            !token ||
            !newPassword
        ) {
            return res
                .status(400)
                .json({ error: Responses.Authentication.missingPasswordResetLinkFields });
        }

        const passwordError: string | null = passwordLengthError(newPassword);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const [, userId, secret] = passwordResetTokenPattern.exec(token) ?? [];

        if (!userId) {
            return answerInvalidCode(res, Responses.Authentication.invalidPasswordResetLink);
        }

        const linkHash: string = passwordResetLinkHash(userId, secret);

        if (!(await hasPasswordResetLink(userId, linkHash))) {
            return answerInvalidCode(res, Responses.Authentication.invalidPasswordResetLink);
        }

        const salt: string = random();
        const user = await resetPasswordWithLink(
            userId,
            linkHash,
            salt,
            await hashPassword(salt, newPassword, ipKey(req.ip))
        );

        if (!user) {
            return answerInvalidCode(res, Responses.Authentication.invalidPasswordResetLink);
        }

        await mailPasswordChanged(user);

        return res.status(200).json({ message: Responses.Authentication.passwordResetSuccess });
    } catch (error) {
        return next(error);
    }
};

type GithubOauthMode = "login" | "link";

interface GithubOauthCookie {
    state: string;
    verifier: string;
    mode: GithubOauthMode;
}

interface GithubOauthStart extends GithubOauthCookie {
    url: string;
}

const githubOauthCookie: string = "__Host-VB-OAUTH";
const githubOauthCookieOptions: express.CookieOptions = {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax"
};

const oauthPage = (mode: GithubOauthMode): string =>
    `${baseSiteUrl}${mode === "link" ? "/account" : "/login"}`;

const redirectWithOauthError = (res: express.Response, mode: GithubOauthMode, code: string) =>
    res.redirect(`${oauthPage(mode)}?oauthError=${code}`);

const startGithubOauth = (res: express.Response, mode: GithubOauthMode): GithubOauthStart => {
    const oauth: GithubOauthCookie = {
        state: createOauthSecret(),
        verifier: createOauthSecret(),
        mode
    };

    res.cookie(githubOauthCookie, oauth, {
        ...githubOauthCookieOptions,
        maxAge: 1000 * 60 * GITHUB_OAUTH_MINUTES
    });

    return { ...oauth, url: buildAuthorizeUrl(oauth.state, oauth.verifier) };
};

const githubLinkProofHash = (sessionTokenHash: string, oauth: GithubOauthCookie): string =>
    authentication(sessionTokenHash, `${oauth.state}/${oauth.verifier}`);

const startGithubLink = async (
    res: express.Response,
    user: UserDocument
): Promise<GithubOauthStart> => {
    const oauth: GithubOauthStart = startGithubOauth(res, "link");
    await setGithubLinkProof(user._id.toString(), {
        hash: githubLinkProofHash(user.authentication.sessionToken, oauth),
        expiresAt: new Date(Date.now() + GITHUB_OAUTH_MINUTES * 60 * 1000)
    });

    return oauth;
};

const githubLinkError = async (
    req: express.Request,
    oauth: GithubOauthCookie
): Promise<string | null> => {
    const user = await getSessionUser(req, "+authentication.sessionToken");

    if (!user) {
        return Responses.GithubOauth.notLoggedIn;
    }

    const sessionTokenHash: string = user.authentication.sessionToken;
    const { matchedCount } = await claimGithubLinkProof(
        user._id.toString(),
        sessionTokenHash,
        githubLinkProofHash(sessionTokenHash, oauth)
    );

    return matchedCount > 0 ? null : Responses.GithubOauth.invalidState;
};

const rejectWrongPassword = async (
    res: express.Response,
    user: UserDocument,
    password: unknown,
    client: string
) => {
    if (typeof password !== "string" || !password) {
        return res.status(400).json({ error: Responses.GithubOauth.missingPassword });
    }

    if (
        !(await verifyPassword(
            user.authentication.salt,
            user.authentication.password,
            password,
            client
        ))
    ) {
        return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
    }

    return null;
};

const loginLinkedGithubUser = async (
    res: express.Response,
    linkedUser: Awaited<ReturnType<typeof getUserByGithubId>>,
    profile: GithubProfile
) => {
    if (linkedUser.suspendedAt) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.accountSuspended);
    }

    const userId: string = linkedUser._id.toString();
    const started: boolean = await startSessionWith(res, userId, (session: ExpiringHash) =>
        loginGithubAccount(userId, profile.id, profile.login, session)
    );

    if (!started) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.invalidState);
    }

    return res.redirect(baseSiteUrl);
};

const signUpWithGithub = async (
    res: express.Response,
    profile: GithubProfile,
    email: string,
    attemptsLeft: number = GITHUB_SIGN_UP_ATTEMPTS
) => {
    try {
        await createUser({
            username: await deriveUsername(profile.login, isUsernameTaken),
            email,
            githubId: profile.id,
            githubLogin: profile.login,
            authentication: { githubVerifiedAt: new Date(), emailVerifiedAt: new Date() }
        });
    } catch (error) {
        if (!isDuplicateKeyError(error)) {
            throw error;
        }

        const linkedUser = await getUserByGithubId(profile.id);

        if (linkedUser) {
            return loginLinkedGithubUser(res, linkedUser, profile);
        }

        if (get(error, "keyPattern.username") && attemptsLeft > 1) {
            return signUpWithGithub(res, profile, email, attemptsLeft - 1);
        }

        if (get(error, "keyPattern.email")) {
            return redirectWithOauthError(res, "login", Responses.GithubOauth.emailExists);
        }

        throw error;
    }

    if (!(await startSessionIfPresent(res, await getUserByGithubId(profile.id)))) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.invalidState);
    }

    return res.redirect(baseSiteUrl);
};

const loginWithGithub = async (res: express.Response, profile: GithubProfile) => {
    const linkedUser = await getUserByGithubId(profile.id);

    if (linkedUser) {
        return loginLinkedGithubUser(res, linkedUser, profile);
    }

    if (!profile.email) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.noVerifiedEmail);
    }

    const email: string = normalizeEmail(profile.email);

    if (!isValidEmail(email)) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.githubError);
    }

    const emailUser = await getUserByEmail(email);

    if (emailUser) {
        return emailUser.githubId === profile.id
            ? loginLinkedGithubUser(res, emailUser, profile)
            : redirectWithOauthError(res, "login", Responses.GithubOauth.emailExists);
    }

    return signUpWithGithub(res, profile, email);
};

const failedLinkError = async (userId: string, githubId: string): Promise<string> => {
    const user = await getUserById(userId);

    return user?.githubId && user.githubId !== githubId && !user.suspendedAt
        ? Responses.GithubOauth.githubOtherLinked
        : Responses.GithubOauth.notLoggedIn;
};

const linkGithub = async (req: express.Request, res: express.Response, profile: GithubProfile) => {
    const user = await getSessionUser(req);

    if (!user) {
        return redirectWithOauthError(res, "link", Responses.GithubOauth.notLoggedIn);
    }

    const linkedUser = await getUserByGithubId(profile.id);

    if (linkedUser && !linkedUser._id.equals(user._id)) {
        return redirectWithOauthError(res, "link", Responses.GithubOauth.githubAlreadyLinked);
    }

    const sessionToken: string = req.cookies[sessionCookie];
    const userId: string = user._id.toString();

    try {
        const linked: boolean = await startSessionWith(res, userId, (session: ExpiringHash) =>
            linkGithubAccount(userId, sessionToken, profile.id, profile.login, session)
        );

        if (!linked) {
            return redirectWithOauthError(res, "link", await failedLinkError(userId, profile.id));
        }
    } catch (error) {
        if (isDuplicateKeyError(error) && get(error, "keyPattern.githubId")) {
            return redirectWithOauthError(res, "link", Responses.GithubOauth.githubAlreadyLinked);
        }

        throw error;
    }

    return res.redirect(`${oauthPage("link")}?github=linked`);
};

export const githubLogin = (req: express.Request, res: express.Response) =>
    isGithubConfigured()
        ? res.redirect(startGithubOauth(res, "login").url)
        : redirectWithOauthError(res, "login", Responses.GithubOauth.notConfigured);

export const githubLink = async (req: express.Request, res: express.Response) => {
    try {
        const user = await getSessionUser(
            req,
            "+authentication.password +authentication.sessionToken"
        );

        if (!user) {
            return redirectWithOauthError(res, "link", Responses.GithubOauth.notLoggedIn);
        }

        if (user.authentication?.password) {
            return redirectWithOauthError(res, "link", Responses.GithubOauth.passwordRequired);
        }

        if (!isGithubConfigured()) {
            return redirectWithOauthError(res, "link", Responses.GithubOauth.notConfigured);
        }

        return res.redirect((await startGithubLink(res, user)).url);
    } catch (error) {
        console.error(error);
        return redirectWithOauthError(res, "link", Responses.GithubOauth.githubError);
    }
};

export const githubStartLink = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { password } = req.body;

        if (!isGithubConfigured()) {
            return res.status(503).json({ error: Responses.GithubOauth.notConfigured });
        }

        const userId: string = get(req, "identity._id").toString();
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password +authentication.sessionToken"
        );

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (user.authentication?.password) {
            const rejected = await rejectWrongPassword(res, user, password, ipKey(req.ip));
            if (rejected) {
                return rejected;
            }
        }

        return res.status(200).json({ url: (await startGithubLink(res, user)).url });
    } catch (error) {
        return next(error);
    }
};

export const githubUnlink = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        const { password } = req.body;

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password"
        );

        if (!user) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        if (!user.githubId) {
            return res.status(404).json({ error: Responses.GithubOauth.githubNotLinked });
        }

        if (!user.authentication?.password) {
            return res
                .status(403)
                .json({ error: Responses.GithubOauth.cannotUnlinkWithoutPassword });
        }

        const rejected = await rejectWrongPassword(res, user, password, ipKey(req.ip));
        if (rejected) {
            return rejected;
        }

        user.githubId = undefined;
        user.githubLogin = undefined;
        await user.save();

        return res.status(200).json({ message: Responses.GithubOauth.githubUnlinkedSuccess });
    } catch (error) {
        if (isDocumentNotFoundError(error)) {
            return res.status(403).json({ error: Responses.notLoggedIn });
        }

        return next(error);
    }
};

export const githubCallback = async (req: express.Request, res: express.Response) => {
    const oauth: GithubOauthCookie | undefined = req.cookies[githubOauthCookie];
    res.clearCookie(githubOauthCookie, githubOauthCookieOptions);

    try {
        const { code, state, error } = req.query;

        if (error) {
            return redirectWithOauthError(
                res,
                oauth?.mode,
                error === "access_denied"
                    ? Responses.GithubOauth.accessDenied
                    : Responses.GithubOauth.githubError
            );
        }

        if (
            typeof oauth?.state !== "string" ||
            typeof code !== "string" ||
            typeof state !== "string" ||
            state !== oauth.state
        ) {
            return redirectWithOauthError(res, oauth?.mode, Responses.GithubOauth.invalidState);
        }

        const linkError: string | null =
            oauth.mode === "link" ? await githubLinkError(req, oauth) : null;

        if (linkError) {
            return redirectWithOauthError(res, "link", linkError);
        }

        const accessToken: string | null = await exchangeCode(code, oauth.verifier);

        if (!accessToken) {
            return redirectWithOauthError(res, oauth?.mode, Responses.GithubOauth.githubError);
        }

        const profile: GithubProfile = await fetchGithubProfile(accessToken);

        return oauth.mode === "link"
            ? await linkGithub(req, res, profile)
            : await loginWithGithub(res, profile);
    } catch (error) {
        console.error(error);
        return redirectWithOauthError(res, oauth?.mode, Responses.GithubOauth.githubError);
    }
};
