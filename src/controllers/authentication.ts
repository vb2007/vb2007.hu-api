import express from "express";
import { get } from "lodash";

import {
    allowPasswordResetResend,
    claimGithubLinkProof,
    claimPasswordResetCode,
    createUser,
    getUserByEmail,
    getUserByGithubId,
    getUserById,
    passwordResetScope,
    resetPassword,
    setGithubLinkProof,
    setPasswordResetCode
} from "../database/users";
import {
    allowPendingRegistrationResend,
    claimPendingRegistrationCode,
    deletePendingRegistration,
    getPendingRegistration,
    registrationCodeScope,
    replacePendingRegistrationCode,
    savePendingRegistration
} from "../database/pendingRegistrations";
import {
    authentication,
    isValidEmail,
    normalizeEmail,
    random,
    passwordLengthError
} from "../helpers";
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
    answerInvalidCode,
    createEmailCode,
    isEmailCodeMatch,
    issueEmailCode,
    normalizeEmailCode,
    answerResendTooSoon,
    resendAllowedBefore
} from "../helpers/emailCodes";
import { emailDomainError } from "../helpers/emailDomain";
import { sendMail } from "../helpers/mail";
import { isDuplicateKeyError } from "../helpers/mongoose";
import { UserDocument, endSession, getSessionUser, startSession } from "../helpers/session";
import { isUsernameTaken, usernameLengthError } from "../helpers/username";
import { Emails } from "../constants/emails";
import { Responses } from "../constants/responses";

import dotenv from "dotenv";
dotenv.config();

export const login = async (req: express.Request, res: express.Response) => {
    try {
        const { email, password } = req.body;

        if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
            return res.status(400).json({ error: Responses.Authentication.missingEmailPassword });
        }

        const user = await getUserByEmail(normalizeEmail(email)).select(
            "+authentication.salt +authentication.password"
        );

        if (!user) {
            return res.status(404).json({ error: Responses.Authentication.userNotFound });
        }

        if (!user.authentication.password) {
            return res.status(403).json({ error: Responses.Authentication.noPasswordSet });
        }

        const expectedHash: string = authentication(user.authentication.salt, password);

        if (user.authentication.password !== expectedHash) {
            return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
        }

        await startSession(res, user);

        return res
            .status(200)
            .json({ message: Responses.Authentication.loginSuccess(user.username) });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const logout = async (req: express.Request, res: express.Response) => {
    try {
        const user = await getSessionUser(req);

        await endSession(res, user);

        return res.status(200).json({ message: Responses.Authentication.logoutSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

const registrationCodeMinutes: number = 15;
const pendingRegistrationHours: number = 24;

const mailRegistrationCode = async (email: string, code: string): Promise<boolean> => {
    try {
        await sendMail({ to: email, ...Emails.registrationCode(code, registrationCodeMinutes) });
        return true;
    } catch (error) {
        console.error(error);
        await allowPendingRegistrationResend(email);
        return false;
    }
};

export const register = async (req: express.Request, res: express.Response) => {
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

        const usernameError: string | null = usernameLengthError(username);
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

        const existingEmail = await getUserByEmail(normalizedEmail);
        if (existingEmail) {
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        if (await isUsernameTaken(username)) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const domainError: string | null = await emailDomainError(normalizedEmail);
        if (domainError) {
            return res.status(400).json({ error: domainError });
        }

        const code: string = createEmailCode();
        const salt: string = random();

        try {
            await savePendingRegistration(
                {
                    username,
                    email: normalizedEmail,
                    authentication: { salt, password: authentication(salt, password) },
                    code: issueEmailCode(
                        registrationCodeScope(normalizedEmail),
                        code,
                        registrationCodeMinutes
                    ),
                    expiresAt: new Date(Date.now() + pendingRegistrationHours * 60 * 60 * 1000)
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

        if (!(await mailRegistrationCode(normalizedEmail, code))) {
            return res.status(503).json({ error: Responses.EmailCodes.mailFailed });
        }

        return res
            .status(202)
            .json({ message: Responses.Authentication.registrationCodeSent(normalizedEmail) });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const checkUsernameAvailable = async (req: express.Request, res: express.Response) => {
    try {
        const username: string = typeof req.query.username === "string" ? req.query.username : "";

        const usernameError: string | null = usernameLengthError(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        return res.status(200).json({ available: !(await isUsernameTaken(username)) });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const resendRegistrationCode = async (req: express.Request, res: express.Response) => {
    try {
        const { email } = req.body;

        if (typeof email !== "string" || !email) {
            return res.status(400).json({ error: Responses.Authentication.missingEmail });
        }

        const normalizedEmail: string = normalizeEmail(email);
        const pending = await getPendingRegistration(normalizedEmail);

        if (pending) {
            const code: string = createEmailCode();
            const { matchedCount } = await replacePendingRegistrationCode(
                normalizedEmail,
                issueEmailCode(
                    registrationCodeScope(normalizedEmail),
                    code,
                    registrationCodeMinutes
                ),
                resendAllowedBefore()
            );

            if (matchedCount === 0) {
                return answerResendTooSoon(res, pending.code?.sentAt);
            }

            if (!(await mailRegistrationCode(normalizedEmail, code))) {
                return res.status(503).json({ error: Responses.EmailCodes.mailFailed });
            }
        }

        return res.status(200).json({ message: Responses.Authentication.registrationCodeResent });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const verifyRegistration = async (req: express.Request, res: express.Response) => {
    try {
        const { email, code } = req.body;

        if (typeof email !== "string" || typeof code !== "string" || !email || !code) {
            return res.status(400).json({ error: Responses.Authentication.missingEmailCode });
        }

        const normalizedEmail: string = normalizeEmail(email);
        const pending = await claimPendingRegistrationCode(normalizedEmail);

        if (
            !pending ||
            !isEmailCodeMatch(
                pending.code.hash,
                registrationCodeScope(normalizedEmail),
                normalizeEmailCode(code)
            )
        ) {
            return answerInvalidCode(res);
        }

        if (await getUserByEmail(normalizedEmail)) {
            await deletePendingRegistration(normalizedEmail);
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        if (await isUsernameTaken(pending.username)) {
            await deletePendingRegistration(normalizedEmail);
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const user = await createUser({
            username: pending.username,
            email: normalizedEmail,
            authentication: { ...pending.authentication, emailVerifiedAt: new Date() }
        });
        await deletePendingRegistration(normalizedEmail);

        await startSession(res, await getUserById(user._id.toString()));

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

        console.error(error);
        return res.sendStatus(500);
    }
};

const passwordResetCodeMinutes: number = 30;

export const requestPasswordReset = async (req: express.Request, res: express.Response) => {
    try {
        const { email } = req.body;

        if (typeof email !== "string" || !email) {
            return res.status(400).json({ error: Responses.Authentication.missingEmail });
        }

        const user = await getUserByEmail(normalizeEmail(email));

        if (user) {
            const userId: string = user._id.toString();
            const code: string = createEmailCode();
            const { matchedCount } = await setPasswordResetCode(
                userId,
                issueEmailCode(passwordResetScope(userId), code, passwordResetCodeMinutes),
                resendAllowedBefore()
            );

            if (matchedCount > 0) {
                try {
                    await sendMail({
                        to: user.email,
                        ...Emails.passwordResetCode(user.username, code, passwordResetCodeMinutes)
                    });
                } catch (error) {
                    console.error("Password reset e-mail not sent:", error);
                    await allowPasswordResetResend(userId);
                }
            }
        }

        return res.status(200).json({ message: Responses.Authentication.passwordResetSent });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const confirmPasswordReset = async (req: express.Request, res: express.Response) => {
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

        const user = await claimPasswordResetCode(normalizeEmail(email));
        const userId: string | undefined = user?._id.toString();
        const codeHash: string | undefined = user?.authentication?.passwordReset?.hash;

        if (
            !codeHash ||
            !isEmailCodeMatch(codeHash, passwordResetScope(userId), normalizeEmailCode(code))
        ) {
            return answerInvalidCode(res);
        }

        const salt: string = random();
        const { matchedCount } = await resetPassword(
            userId,
            codeHash,
            salt,
            authentication(salt, newPassword)
        );

        if (matchedCount === 0) {
            return answerInvalidCode(res);
        }

        try {
            await sendMail({ to: user.email, ...Emails.passwordChanged(user.username) });
        } catch (error) {
            console.error(error);
        }

        return res.status(200).json({ message: Responses.Authentication.passwordResetSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
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
const githubOauthMinutes: number = 10;
const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

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
        maxAge: 1000 * 60 * githubOauthMinutes
    });

    return { ...oauth, url: buildAuthorizeUrl(oauth.state, oauth.verifier) };
};

const redirectToGithub = (res: express.Response, mode: GithubOauthMode) => {
    if (!isGithubConfigured()) {
        return redirectWithOauthError(res, mode, Responses.GithubOauth.notConfigured);
    }

    return res.redirect(startGithubOauth(res, mode).url);
};

const githubLinkProofHash = (sessionToken: string, oauth: GithubOauthCookie): string =>
    authentication(sessionToken, `${oauth.state}/${oauth.verifier}`);

const startGithubLink = async (
    res: express.Response,
    user: UserDocument
): Promise<GithubOauthStart> => {
    const oauth: GithubOauthStart = startGithubOauth(res, "link");
    await setGithubLinkProof(user._id.toString(), {
        hash: githubLinkProofHash(user.authentication.sessionToken, oauth),
        expiresAt: new Date(Date.now() + githubOauthMinutes * 60 * 1000)
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

    const sessionToken: string = user.authentication.sessionToken;
    const { matchedCount } = await claimGithubLinkProof(
        user._id.toString(),
        sessionToken,
        githubLinkProofHash(sessionToken, oauth)
    );

    return matchedCount > 0 ? null : Responses.GithubOauth.invalidState;
};

const rejectWrongPassword = (res: express.Response, user: UserDocument, password: unknown) => {
    if (typeof password !== "string" || !password) {
        return res.status(400).json({ error: Responses.GithubOauth.missingPassword });
    }

    if (user.authentication.password !== authentication(user.authentication.salt, password)) {
        return res.status(403).json({ error: Responses.Authentication.incorrectPassword });
    }

    return null;
};

const githubSignUpAttempts: number = 3;

const loginLinkedGithubUser = async (
    res: express.Response,
    linkedUser: Awaited<ReturnType<typeof getUserByGithubId>>,
    profile: GithubProfile
) => {
    linkedUser.githubLogin = profile.login;
    linkedUser.authentication.githubVerifiedAt = new Date();
    await startSession(res, linkedUser);
    return res.redirect(baseSiteUrl);
};

const signUpWithGithub = async (
    res: express.Response,
    profile: GithubProfile,
    email: string,
    attemptsLeft: number = githubSignUpAttempts
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

    await startSession(res, await getUserByGithubId(profile.id));
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

    const emailUser = await getUserByEmail(email);

    if (emailUser) {
        return emailUser.githubId === profile.id
            ? loginLinkedGithubUser(res, emailUser, profile)
            : redirectWithOauthError(res, "login", Responses.GithubOauth.emailExists);
    }

    return signUpWithGithub(res, profile, email);
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

    if (user.githubId && user.githubId !== profile.id) {
        return redirectWithOauthError(res, "link", Responses.GithubOauth.githubOtherLinked);
    }

    user.githubId = profile.id;
    user.githubLogin = profile.login;
    user.authentication.githubVerifiedAt = new Date();

    try {
        await startSession(res, user);
    } catch (error) {
        if (isDuplicateKeyError(error) && get(error, "keyPattern.githubId")) {
            return redirectWithOauthError(res, "link", Responses.GithubOauth.githubAlreadyLinked);
        }

        throw error;
    }

    return res.redirect(`${oauthPage("link")}?github=linked`);
};

export const githubLogin = (req: express.Request, res: express.Response) =>
    redirectToGithub(res, "login");

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

export const githubStartLink = async (req: express.Request, res: express.Response) => {
    try {
        const { password } = req.body;

        if (!isGithubConfigured()) {
            return res.status(503).json({ error: Responses.GithubOauth.notConfigured });
        }

        const userId: string = get(req, "identity._id").toString();
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password +authentication.sessionToken"
        );

        if (user.authentication?.password) {
            const rejected = rejectWrongPassword(res, user, password);
            if (rejected) {
                return rejected;
            }
        }

        return res.status(200).json({ url: (await startGithubLink(res, user)).url });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
};

export const githubUnlink = async (req: express.Request, res: express.Response) => {
    try {
        const { password } = req.body;

        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select(
            "+authentication.salt +authentication.password"
        );

        if (!user.githubId) {
            return res.status(404).json({ error: Responses.GithubOauth.githubNotLinked });
        }

        if (!user.authentication?.password) {
            return res
                .status(403)
                .json({ error: Responses.GithubOauth.cannotUnlinkWithoutPassword });
        }

        const rejected = rejectWrongPassword(res, user, password);
        if (rejected) {
            return rejected;
        }

        user.githubId = undefined;
        user.githubLogin = undefined;
        await user.save();

        return res.status(200).json({ message: Responses.GithubOauth.githubUnlinkedSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
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
