import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const clientId: string = process.env.GITHUB_CLIENT_ID;
const clientSecret: string = process.env.GITHUB_CLIENT_SECRET;
const callbackUrl: string = process.env.GITHUB_CALLBACK_URL;

const githubApiHeaders = (accessToken: string): Record<string, string> => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "vb2007.hu-api"
});

export interface GithubProfile {
    id: string;
    login: string;
    email: string | null;
}

interface GithubEmail {
    email: string;
    primary: boolean;
    verified: boolean;
}

export const isGithubConfigured = (): boolean => Boolean(clientId && clientSecret && callbackUrl);

export const createOauthSecret = (): string => crypto.randomBytes(32).toString("base64url");

export const createCodeChallenge = (verifier: string): string =>
    crypto.createHash("sha256").update(verifier).digest("base64url");

export const buildAuthorizeUrl = (state: string, verifier: string): string => {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: "read:user user:email",
        state,
        code_challenge: createCodeChallenge(verifier),
        code_challenge_method: "S256",
        allow_signup: "true"
    });

    return `https://github.com/login/oauth/authorize?${params}`;
};

export const exchangeCode = async (code: string, verifier: string): Promise<string | null> => {
    const response: Response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: callbackUrl,
            code_verifier: verifier
        })
    });

    const body = await response.json();
    return typeof body.access_token === "string" ? body.access_token : null;
};

const fetchGithubApi = async (path: string, accessToken: string): Promise<any> => {
    const response: Response = await fetch(`https://api.github.com${path}`, {
        headers: githubApiHeaders(accessToken)
    });

    if (!response.ok) {
        throw new Error(`GitHub API ${path} answered ${response.status}`);
    }

    return response.json();
};

export const fetchGithubProfile = async (accessToken: string): Promise<GithubProfile> => {
    const [user, emails] = await Promise.all([
        fetchGithubApi("/user", accessToken),
        fetchGithubApi("/user/emails", accessToken)
    ]);

    const primaryEmail: GithubEmail | undefined = (emails as GithubEmail[]).find(
        (email: GithubEmail): boolean => email.primary && email.verified
    );

    return { id: String(user.id), login: user.login, email: primaryEmail?.email ?? null };
};

export const deriveUsername = async (
    login: string,
    isTaken: (username: string) => Promise<boolean>
): Promise<string> => {
    const base: string = login.slice(0, 16).padEnd(2, "0");

    if (!(await isTaken(base))) {
        return base;
    }

    for (let suffix: number = 1; ; suffix++) {
        const candidate: string = base.slice(0, 16 - String(suffix).length) + suffix;

        if (!(await isTaken(candidate))) {
            return candidate;
        }
    }
};
