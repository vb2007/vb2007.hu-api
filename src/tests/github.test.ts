import express from "express";
import request from "supertest";
import supertest from "supertest";
import { githubCallback } from "../controllers/authentication";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import * as userDatabase from "../database/users";
import { UserModel } from "../database/users";
import { GithubProfile, createCodeChallenge, deriveUsername } from "../helpers/github";
import { isUsernameTaken } from "../helpers/username";
import { sessionCookie } from "../helpers/session";
import { hashSessionToken } from "../helpers";
import {
    TestUser,
    createTestUser,
    linkGithub,
    randomHex,
    sessionTokenOf,
    testEmailOf,
    testEmailOfLength
} from "./helpers/testUsers";
import { describeWithGithub, itWithGithub } from "./helpers/githubTests";

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

const holdGithubLinkChecks = (count: number): void => {
    const waitForAll: () => Promise<void> = barrier(count);
    const getUserByGithubId = userDatabase.getUserByGithubId;

    jest.spyOn(userDatabase, "getUserByGithubId").mockImplementation(
        (githubId: string) =>
            getUserByGithubId(githubId).then(async (user) => {
                await waitForAll();
                return user;
            }) as unknown as ReturnType<typeof getUserByGithubId>
    );
};

const holdGithubIdLookup = (): { reached: Promise<void>; release: () => void } => {
    let reach: () => void;
    let release: () => void;
    const reached: Promise<void> = new Promise((resolve) => (reach = resolve));
    const released: Promise<void> = new Promise((resolve) => (release = resolve));
    const getUserByGithubId = userDatabase.getUserByGithubId;

    jest.spyOn(userDatabase, "getUserByGithubId").mockImplementation(
        (githubId: string) =>
            getUserByGithubId(githubId).then(async (user) => {
                reach();
                await released;
                return user;
            }) as unknown as ReturnType<typeof getUserByGithubId>
    );

    return { reached, release };
};

const mockGithub = (
    profiles: GithubProfile[],
    holdUntilAll: (count: number) => void = holdUserSaves
): void => {
    const waitForAll: () => Promise<void> = barrier(profiles.length);
    holdUntilAll(profiles.length);

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

const nextGithubFetch = (): Promise<void> =>
    new Promise((resolve: () => void): void => {
        const fetchGithub = jest.mocked(global.fetch).getMockImplementation();

        jest.mocked(global.fetch).mockImplementation((...args: Parameters<typeof fetch>) => {
            resolve();
            return fetchGithub(...args);
        });
    });

const startLinkOf = async (user: TestUser): Promise<{ state: string; verifier: string }> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/github/link")
        .set("Cookie", user.cookie)
        .send({ password: user.password })
        .expect(200);
    const setCookie: string = response.headers["set-cookie"][0];

    return JSON.parse(
        decodeURIComponent(setCookie.split(";")[0].slice("__Host-VB-OAUTH=".length)).slice(2)
    );
};

const runGithubCallback = async (profileIndex: number, mode: "login" | "link", user?: TestUser) => {
    const { state, verifier } =
        mode === "link" ? await startLinkOf(user) : { state: randomHex(8), verifier: randomHex(8) };
    const req = {
        cookies: {
            "__Host-VB-OAUTH": { state, verifier, mode },
            ...(user && { [sessionCookie]: sessionTokenOf(user.cookie) })
        },
        query: { code: String(profileIndex), state }
    };
    const res = { redirect: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() };

    await githubCallback(req as unknown as express.Request, res as unknown as express.Response);

    return res;
};

const redirectOf = (res: Awaited<ReturnType<typeof runGithubCallback>>): URL =>
    new URL(res.redirect.mock.calls[0][0]);

const sessionCookiesOf = (res: Awaited<ReturnType<typeof runGithubCallback>>): string[] =>
    res.cookie.mock.calls
        .filter(([name]: [string]): boolean => name === sessionCookie)
        .map(([, value]: [string, string]): string => value);

const callGithubCallback = async (
    profileIndex: number,
    mode: "login" | "link",
    user?: TestUser
): Promise<URL> => redirectOf(await runGithubCallback(profileIndex, mode, user));

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
        });

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
    });

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
    });

    it("should answer emailExists to parallel sign-ups sharing an e-mail", async (): Promise<void> => {
        const email: string = testEmailOf(`gh${randomHex(5)}`);
        mockGithub([fakeGithubProfile(email), fakeGithubProfile(email)]);

        const redirects: URL[] = await Promise.all([
            callGithubCallback(0, "login"),
            callGithubCallback(1, "login")
        ]);

        expect(oauthErrorsOf(redirects)).toEqual(["", Responses.GithubOauth.emailExists]);
        expect(await UserModel.countDocuments({ email })).toBe(1);
    });

    itWithGithub(
        "should answer githubAlreadyLinked to parallel links of one GitHub account",
        async (): Promise<void> => {
            const users: TestUser[] = await Promise.all([
                createTestUser("ghl"),
                createTestUser("ghl")
            ]);
            const profile: GithubProfile = fakeGithubProfile();
            mockGithub([profile, profile], holdGithubLinkChecks);

            const redirects: URL[] = await Promise.all([
                callGithubCallback(0, "link", users[0]),
                callGithubCallback(1, "link", users[1])
            ]);

            expect(oauthErrorsOf(redirects)).toEqual([
                "",
                Responses.GithubOauth.githubAlreadyLinked
            ]);
            expect(
                redirects.filter((redirect: URL): boolean => redirect.searchParams.has("github"))
            ).toHaveLength(1);
            expect(await UserModel.countDocuments({ githubId: profile.id })).toBe(1);
        }
    );

    itWithGithub(
        "should answer githubOtherLinked to parallel links of two GitHub accounts",
        async (): Promise<void> => {
            const user: TestUser = await createTestUser("ghl");
            const profiles: GithubProfile[] = [fakeGithubProfile(), fakeGithubProfile()];
            mockGithub(profiles, holdGithubLinkChecks);
            const firstExchange: Promise<void> = nextGithubFetch();

            const firstLink: Promise<URL> = callGithubCallback(0, "link", user);
            await Promise.race([firstExchange, firstLink]);
            const redirects: URL[] = await Promise.all([
                firstLink,
                callGithubCallback(1, "link", user)
            ]);

            expect(oauthErrorsOf(redirects)).toEqual(["", Responses.GithubOauth.githubOtherLinked]);
            const linked: number = redirects.findIndex((redirect: URL): boolean =>
                redirect.searchParams.has("github")
            );
            expect((await UserModel.findById(user.id)).githubId).toBe(profiles[linked].id);
        }
    );
});

describeWithGithub("GitHub OAuth link", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should link the already linked GitHub account again", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghl");
        const profile: GithubProfile = fakeGithubProfile();
        await UserModel.updateOne({ _id: user.id }, { githubId: profile.id });
        mockGithub([profile]);

        const redirect: URL = await callGithubCallback(0, "link", user);

        expect(redirect.searchParams.get("github")).toBe("linked");
        expect((await UserModel.findById(user.id)).githubLogin).toBe(profile.login);
    });

    it("should link GitHub and start a new session", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghk");
        const profile: GithubProfile = fakeGithubProfile();
        mockGithub([profile]);

        const res = await runGithubCallback(0, "link", user);

        expect(redirectOf(res).searchParams.get("github")).toBe("linked");
        const sessionTokens: string[] = sessionCookiesOf(res);
        expect(sessionTokens).toHaveLength(1);
        const stored = await UserModel.findById(user.id)
            .select("+authentication.sessionToken")
            .lean();
        expect(stored.githubId).toBe(profile.id);
        expect(stored.githubLogin).toBe(profile.login);
        expect(stored.authentication.sessionToken).toBe(hashSessionToken(sessionTokens[0]));
    });

    it("should answer notLoggedIn when the account is suspended meanwhile", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghk");
        const profile: GithubProfile = fakeGithubProfile();
        mockGithub([profile], (): void => {});
        const { reached, release } = holdGithubIdLookup();

        const link = runGithubCallback(0, "link", user);
        await reached;
        await userDatabase.setUserSuspension(user.id, true);
        release();
        const res = await link;

        expect(redirectOf(res).searchParams.get("oauthError")).toBe(
            Responses.GithubOauth.notLoggedIn
        );
        expect(sessionCookiesOf(res)).toEqual([]);
        const stored = await UserModel.findById(user.id)
            .select("+authentication.sessionToken")
            .lean();
        expect(stored.authentication?.sessionToken).toBeUndefined();
    });
});

describe("GitHub OAuth login of a linked account", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should start a session and refresh githubLogin", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghn");
        const profile: GithubProfile = { ...fakeGithubProfile(), id: await linkGithub(user) };
        mockGithub([profile]);

        const res = await runGithubCallback(0, "login");

        expect(redirectOf(res).searchParams.has("oauthError")).toBe(false);
        const [sessionToken] = sessionCookiesOf(res);
        const stored = await UserModel.findById(user.id)
            .select("+authentication.sessionToken +authentication.githubVerifiedAt")
            .lean();
        expect(stored.githubLogin).toBe(profile.login);
        expect(stored.authentication.githubVerifiedAt).toBeInstanceOf(Date);
        expect(stored.authentication.sessionToken).toBe(hashSessionToken(sessionToken));
    });

    it("should answer invalidState when GitHub is unlinked and relinked meanwhile", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghr");
        const oldProfile: GithubProfile = { ...fakeGithubProfile(), id: await linkGithub(user) };
        const newProfile: GithubProfile = fakeGithubProfile();
        mockGithub([oldProfile], (): void => {});
        const { reached, release } = holdGithubIdLookup();

        const login = runGithubCallback(0, "login");
        await reached;
        await request(TestData.apiURL)
            .delete("/auth/github/link")
            .set("Cookie", user.cookie)
            .send({ password: user.password })
            .expect(200);
        await userDatabase.linkGithubAccount(user.id, newProfile.id, newProfile.login);
        release();
        const res = await login;

        expect(redirectOf(res).searchParams.get("oauthError")).toBe(
            Responses.GithubOauth.invalidState
        );
        expect(sessionCookiesOf(res)).toEqual([]);
        const stored = await UserModel.findById(user.id)
            .select("+authentication.sessionToken")
            .lean();
        expect(stored.githubId).toBe(newProfile.id);
        expect(stored.githubLogin).toBe(newProfile.login);
        expect(stored.authentication.sessionToken).toBe(
            hashSessionToken(sessionTokenOf(user.cookie))
        );
    });

    it("should answer invalidState when the account is suspended meanwhile", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghr");
        const profile: GithubProfile = { ...fakeGithubProfile(), id: await linkGithub(user) };
        mockGithub([profile], (): void => {});
        const { reached, release } = holdGithubIdLookup();

        const login = runGithubCallback(0, "login");
        await reached;
        await userDatabase.setUserSuspension(user.id, true);
        release();
        const res = await login;

        expect(redirectOf(res).searchParams.get("oauthError")).toBe(
            Responses.GithubOauth.invalidState
        );
        expect(sessionCookiesOf(res)).toEqual([]);
        const stored = await UserModel.findById(user.id)
            .select("+authentication.sessionToken")
            .lean();
        expect(stored.githubLogin).not.toBe(profile.login);
        expect(stored.authentication?.sessionToken).toBeUndefined();
    });
});

describe("GitHub OAuth login of a suspended account", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should answer accountSuspended without starting a session", async (): Promise<void> => {
        const user: TestUser = await createTestUser("ghs");
        const githubId: string = await linkGithub(user);
        await userDatabase.setUserSuspension(user.id, true);
        mockGithub([{ id: githubId, login: `gh${randomHex(5)}`, email: user.email }]);

        const redirect: URL = await callGithubCallback(0, "login");

        expect(redirect.pathname).toBe("/login");
        expect(redirect.searchParams.get("oauthError")).toBe(
            Responses.GithubOauth.accountSuspended
        );
        expect(UserModel.prototype.save).not.toHaveBeenCalled();

        const stored = await UserModel.findById(user.id)
            .select("+authentication.sessionToken")
            .lean();
        expect(stored.authentication?.sessionToken).toBeUndefined();
    });
});

describe("GitHub OAuth sign-up e-mail validation", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it.each([
        ["two @ signs", `gh${randomHex(5)}@@${TestData.emailDomain}`],
        [
            "two dots in a row in the domain",
            testEmailOf(`gh${randomHex(5)}`, TestData.emailDomain.replace(".", ".."))
        ],
        ["300 characters", testEmailOfLength(300)]
    ])(
        "should answer githubError to an e-mail with %s",
        async (_: string, email: string): Promise<void> => {
            const profile: GithubProfile = fakeGithubProfile(email);
            mockGithub([profile]);

            const redirect: URL = await callGithubCallback(0, "login");

            expect(redirect.searchParams.get("oauthError")).toBe(Responses.GithubOauth.githubError);
            expect(UserModel.prototype.save).not.toHaveBeenCalled();
            expect(await UserModel.countDocuments({ githubId: profile.id })).toBe(0);
            expect(await UserModel.countDocuments({ email })).toBe(0);
        }
    );
});
