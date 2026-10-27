import express from "express";
import { get } from "lodash";

import {
    createUser,
    getUserByEmail,
    getUserByGithubId,
    getUserById,
    getUserBySessionToken,
    getUserByUsername
} from "../database/users";
import { authentication, normalizeEmail, random, validatePassword } from "../helpers";
import {
    GithubProfile,
    buildAuthorizeUrl,
    createOauthSecret,
    deriveUsername,
    exchangeCode,
    fetchGithubProfile,
    isGithubConfigured
} from "../helpers/github";
import { endSession, startSession } from "../helpers/session";
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
        const sessionToken: string = req.cookies["VB-AUTH"];
        const user = sessionToken ? await getUserBySessionToken(sessionToken) : null;

        await endSession(res, user);

        return res.status(200).json({ message: Responses.Authentication.logoutSuccess });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
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

        if (username.length < 2) {
            return res.status(400).json({ error: Responses.Authentication.usernameTooShort });
        }

        if (username.length > 16) {
            return res.status(400).json({ error: Responses.Authentication.usernameTooLong });
        }

        const passwordError: string | null = validatePassword(password);
        if (passwordError) {
            return res.status(400).json({ error: passwordError });
        }

        const normalizedEmail: string = normalizeEmail(email);
        const emailRegex = /^\S+@\S+\.\S+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return res.status(400).json({ error: Responses.Authentication.invalidEmailFormat });
        }

        const existingEmail = await getUserByEmail(normalizedEmail);
        if (existingEmail) {
            return res.status(409).json({ error: Responses.Authentication.emailAlreadyExists });
        }

        const existingUsername = await getUserByUsername(username);
        if (existingUsername) {
            return res.status(409).json({ error: Responses.Authentication.usernameTaken });
        }

        const salt: string = random();
        const user = await createUser({
            username,
            email: normalizedEmail,
            authentication: {
                salt,
                password: authentication(salt, password)
            }
        });

        return res
            .status(201)
            .json({ message: Responses.Authentication.registrationSuccess(user.username) });
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

const githubOauthCookie: string = "VB-OAUTH";
const githubOauthCookiePath: string = "/auth/github";
const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

const oauthPage = (mode: GithubOauthMode): string =>
    `${baseSiteUrl}${mode === "link" ? "/account" : "/login"}`;

const redirectWithOauthError = (res: express.Response, mode: GithubOauthMode, code: string) =>
    res.redirect(`${oauthPage(mode)}?oauthError=${code}`);

const redirectToGithub = (res: express.Response, mode: GithubOauthMode) => {
    if (!isGithubConfigured()) {
        return redirectWithOauthError(res, mode, Responses.GithubOauth.notConfigured);
    }

    const oauth: GithubOauthCookie = {
        state: createOauthSecret(),
        verifier: createOauthSecret(),
        mode
    };

    res.cookie(githubOauthCookie, oauth, {
        path: githubOauthCookiePath,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 1000 * 60 * 10
    });

    return res.redirect(buildAuthorizeUrl(oauth.state, oauth.verifier));
};

const isUsernameTaken = async (username: string): Promise<boolean> =>
    Boolean(await getUserByUsername(username));

const loginWithGithub = async (res: express.Response, profile: GithubProfile) => {
    const linkedUser = await getUserByGithubId(profile.id);

    if (linkedUser) {
        linkedUser.githubLogin = profile.login;
        await startSession(res, linkedUser);
        return res.redirect(baseSiteUrl);
    }

    if (!profile.email) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.noVerifiedEmail);
    }

    const email: string = normalizeEmail(profile.email);

    if (await getUserByEmail(email)) {
        return redirectWithOauthError(res, "login", Responses.GithubOauth.emailExists);
    }

    await createUser({
        username: await deriveUsername(profile.login, isUsernameTaken),
        email,
        githubId: profile.id,
        githubLogin: profile.login
    });

    await startSession(res, await getUserByGithubId(profile.id));
    return res.redirect(baseSiteUrl);
};

const linkGithub = async (req: express.Request, res: express.Response, profile: GithubProfile) => {
    const sessionToken: string = req.cookies["VB-AUTH"];
    const user = sessionToken ? await getUserBySessionToken(sessionToken) : null;

    if (!user) {
        return redirectWithOauthError(res, "link", Responses.GithubOauth.notLoggedIn);
    }

    const linkedUser = await getUserByGithubId(profile.id);

    if (linkedUser && !linkedUser._id.equals(user._id)) {
        return redirectWithOauthError(res, "link", Responses.GithubOauth.githubAlreadyLinked);
    }

    user.githubId = profile.id;
    user.githubLogin = profile.login;
    await user.save();

    return res.redirect(`${oauthPage("link")}?github=linked`);
};

export const githubLogin = (req: express.Request, res: express.Response) =>
    redirectToGithub(res, "login");

export const githubLink = (req: express.Request, res: express.Response) =>
    redirectToGithub(res, "link");

export const githubUnlink = async (req: express.Request, res: express.Response) => {
    try {
        const userId: string = get(req, "identity._id");
        const user = await getUserById(userId).select("+authentication.password");

        if (!user.githubId) {
            return res.status(404).json({ error: Responses.GithubOauth.githubNotLinked });
        }

        if (!user.authentication?.password) {
            return res
                .status(403)
                .json({ error: Responses.GithubOauth.cannotUnlinkWithoutPassword });
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
    res.clearCookie(githubOauthCookie, { path: githubOauthCookiePath });

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
