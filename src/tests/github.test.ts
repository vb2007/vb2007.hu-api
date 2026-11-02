import express from "express";
import { githubCallback } from "../controllers/authentication";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { GithubProfile, createCodeChallenge, deriveUsername } from "../helpers/github";
import { isUsernameTaken } from "../helpers/username";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";

const takenBy =
    (usernames: string[]) =>
    async (username: string): Promise<boolean> =>
        usernames.includes(username);

const fakeGithubProfile = (email: string = testEmailOf(`gh${randomHex(5)}`)): GithubProfile => ({
    id: `${TestData.runId}-${randomHex(6)}`,
    login: `gh${randomHex(5)}`,
    email
});

const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const barrier = (count: number, timeoutMs: number = 5000): (() => Promise<void>) => {
    let release: () => void;
    const released: Promise<void> = new Promise((resolve) => (release = resolve));
    const timeout: NodeJS.Timeout = setTimeout((): void => release(), timeoutMs).unref();
    let arrived: number = 0;

    return (): Promise<void> => {
        if (++arrived === count) {
            clearTimeout(timeout);
            release();
        }

        return released;
    };
};

const holdUserSaves = (count: number): void => {
    const waitForAll: () => Promise<void> = barrier(count);
    const save = UserModel.prototype.save;

    jest.spyOn(UserModel.prototype, "save").mockImplementation(async function (
        this: InstanceType<typeof UserModel>,
        ...args: Parameters<typeof save>
    ) {
        await waitForAll();
        return save.apply(this, args);
    });
};

const mockGithub = (profiles: GithubProfile[]): void => {
    const waitForAll: () => Promise<void> = barrier(profiles.length);
    holdUserSaves(profiles.length);

    jest.spyOn(global, "fetch").mockImplementation(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url: string = input.toString();

            if (url === "https://github.com/login/oauth/access_token") {
                await waitForAll();
                return jsonResponse({ access_token: JSON.parse(String(init.body)).code });
            }

            const accessToken: string = (init.headers as Record<string, string>).Authorization;
            const profile: GithubProfile = profiles[Number(accessToken.replace("Bearer ", ""))];

            if (url === "https://api.github.com/user") {
                return jsonResponse({ id: profile.id, login: profile.login });
            }

            if (url === "https://api.github.com/user/emails") {
                return jsonResponse([{ email: profile.email, primary: true, verified: true }]);
            }

            throw new Error(`Unexpected fetch of ${url}`);
        }
    );
};

const sessionTokenOf = (user: TestUser): string =>
    decodeURIComponent(user.cookie.split(";")[0].split("=")[1]);

const callGithubCallback = async (
    profileIndex: number,
    mode: "login" | "link",
    user?: TestUser
): Promise<URL> => {
    const state: string = randomHex(8);
    const req = {
        cookies: {
            "VB-OAUTH": { state, verifier: randomHex(8), mode },
            ...(user && { "VB-AUTH": sessionTokenOf(user) })
        },
        query: { code: String(profileIndex), state }
    };
    const res = { redirect: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() };

    await githubCallback(req as unknown as express.Request, res as unknown as express.Response);

    return new URL(res.redirect.mock.calls[0][0]);
};

const oauthErrorsOf = (redirects: URL[]): string[] =>
    redirects.map((redirect: URL): string => redirect.searchParams.get("oauthError") ?? "").sort();

describe("GitHub OAuth helpers", (): void => {
    describe("createCodeChallenge", (): void => {
        it("should match the RFC 7636 S256 example", (): void => {
            expect(createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
            );
        });
    });

    describe("deriveUsername", (): void => {
        it("should keep a free GitHub login as is", async (): Promise<void> => {
            expect(await deriveUsername("octocat", takenBy([]))).toBe("octocat");
        });

        it("should cut logins longer than 16 characters", async (): Promise<void> => {
            expect(await deriveUsername("a-very-long-github-login", takenBy([]))).toBe(
                "a-very-long-gith"
            );
        });

        it("should pad one character logins to 2 characters", async (): Promise<void> => {
            expect(await deriveUsername("a", takenBy([]))).toBe("a0");
        });

        it("should add a numeric suffix when the login is taken", async (): Promise<void> => {
            expect(await deriveUsername("octocat", takenBy(["octocat", "octocat1"]))).toBe(
                "octocat2"
            );
        });

        it("should stay within 16 characters with a suffix", async (): Promise<void> => {
            expect(await deriveUsername("sixteen-chars-ab", takenBy(["sixteen-chars-ab"]))).toBe(
                "sixteen-chars-a1"
            );
        });
    });

    describe("deriveUsername with isUsernameTaken", (): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("gh");
        }, 25000);

        it("should add a numeric suffix when the login is taken in another case", async (): Promise<void> => {
            const login: string = user.username.toUpperCase();

            expect(await deriveUsername(login, isUsernameTaken)).toBe(`${login}1`);
        });
    });
});

describe("GitHub OAuth callback races", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should log in both parallel sign-ups of one GitHub account", async (): Promise<void> => {
        const profile: GithubProfile = fakeGithubProfile();
        mockGithub([profile, profile]);

        const redirects: URL[] = await Promise.all([
            callGithubCallback(0, "login"),
            callGithubCallback(1, "login")
        ]);

        expect(oauthErrorsOf(redirects)).toEqual(["", ""]);
        expect(await UserModel.countDocuments({ githubId: profile.id })).toBe(1);
    }, 25000);

    it("should give parallel sign-ups with one login different usernames", async (): Promise<void> => {
        const login: string = `gh${randomHex(5)}`;
        const profiles: GithubProfile[] = [fakeGithubProfile(), fakeGithubProfile()].map(
            (profile: GithubProfile): GithubProfile => ({ ...profile, login })
        );
        mockGithub(profiles);

        const redirects: URL[] = await Promise.all([
            callGithubCallback(0, "login"),
            callGithubCallback(1, "login")
        ]);

        expect(oauthErrorsOf(redirects)).toEqual(["", ""]);
        expect(
            await UserModel.distinct("username", {
                githubId: { $in: profiles.map((profile: GithubProfile): string => profile.id) }
            })
        ).toHaveLength(2);
    }, 25000);

    it("should answer emailExists to parallel sign-ups sharing an e-mail", async (): Promise<void> => {
        const email: string = testEmailOf(`gh${randomHex(5)}`);
        mockGithub([fakeGithubProfile(email), fakeGithubProfile(email)]);

        const redirects: URL[] = await Promise.all([
            callGithubCallback(0, "login"),
            callGithubCallback(1, "login")
        ]);

        expect(oauthErrorsOf(redirects)).toEqual(["", Responses.GithubOauth.emailExists]);
        expect(await UserModel.countDocuments({ email })).toBe(1);
    }, 25000);

    it("should answer githubAlreadyLinked to parallel links of one GitHub account", async (): Promise<void> => {
        const users: TestUser[] = await Promise.all([createTestUser("ghl"), createTestUser("ghl")]);
        const profile: GithubProfile = fakeGithubProfile();
        mockGithub([profile, profile]);

        const redirects: URL[] = await Promise.all([
            callGithubCallback(0, "link", users[0]),
            callGithubCallback(1, "link", users[1])
        ]);

        expect(oauthErrorsOf(redirects)).toEqual(["", Responses.GithubOauth.githubAlreadyLinked]);
        expect(
            redirects.filter((redirect: URL): boolean => redirect.searchParams.has("github"))
        ).toHaveLength(1);
        expect(await UserModel.countDocuments({ githubId: profile.id })).toBe(1);
    }, 25000);
});
