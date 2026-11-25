import express from "express";
import fs from "fs";
import path from "path";
import request from "supertest";
import supertest from "supertest";
import { Responses } from "../constants/responses";
import { TestData } from "../constants/testData";
import {
    API_KEYS_MAX,
    EMAIL_CHANGE_CODE_MINUTES,
    EMAIL_CODE_RESEND_SECONDS,
    GITHUB_REAUTH_MINUTES,
    SESSION_MAX_AGE_MS
} from "../constants/limits";
import { renameUser, updateUserSuspension, updateUserUploadQuota } from "../controllers/admin";
import { createApiKey, rotateApiKeyById } from "../controllers/apiKeys";
import { login, verifyRegistration } from "../controllers/authentication";
import { finishPasskeyRegistration, passkeyLogin } from "../controllers/passkeys";
import {
    changeEmail,
    changePassword,
    deleteUser as deleteAccount,
    setPassword
} from "../controllers/users";
import * as apiKeysDatabase from "../database/apiKeys";
import * as mfaDatabase from "../database/mfa";
import { savePasskeyChallenge } from "../database/passkeys";
import * as userUploadsDatabase from "../database/userUploads";
import * as usersDatabase from "../database/users";
import {
    TestUser,
    addPasteAndShortUrl,
    confirmGithub,
    countOwnedContent,
    createTestUser,
    isStored,
    isolatedClientIp,
    linkGithub,
    randomHex,
    registerRequest,
    scryptHashPattern,
    sessionTokenOf,
    setRegistrationCode,
    storeSession,
    storedAuthentication,
    testEmailOf,
    updateStoredUser
} from "./helpers/testUsers";
import { SoftwareAuthenticator, registerPasskey } from "./helpers/passkeys";
import { turnOnEmailMfa } from "./helpers/mfa";
import { authentication, hashSessionToken, random } from "../helpers";
import { createEmailCode, hashEmailCode, issueEmailCode } from "../helpers/emailCodes";
import * as mail from "../helpers/mail";
import * as passwordHelpers from "../helpers/password";
import {
    passkeyChallengeMs,
    passkeyLoginCookie,
    passkeyRegistrationCookie,
    userHandleOf
} from "../helpers/passkeys";
import { sessionCookie } from "../helpers/session";
import { runRequestReset } from "./helpers/passwordReset";

interface FakeResponse {
    status: jest.Mock;
    json: jest.Mock;
    set: jest.Mock;
    cookie: jest.Mock;
    clearCookie: jest.Mock;
}

type Handler = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => Promise<unknown>;

const run = async (
    handler: Handler,
    fields: object
): Promise<{ res: FakeResponse; next: jest.Mock }> => {
    const res = {} as FakeResponse;
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    res.cookie = jest.fn().mockReturnValue(res);
    res.clearCookie = jest.fn().mockReturnValue(res);
    const next: jest.Mock = jest.fn();

    await handler(
        { ip: "127.0.0.1", params: {}, body: {}, cookies: {}, ...fields } as express.Request,
        res as unknown as express.Response,
        next
    );

    return { res, next };
};

const expectAnswer = (
    { res, next }: { res: FakeResponse; next: jest.Mock },
    status: number,
    error: string
): void => {
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error });
    expect(res.cookie).not.toHaveBeenCalled();
};

const deleteUser = (id: string) => usersDatabase.deleteUserById(id);

const testPng: Buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const vanishDuringLookup = (
    name: "getUserById" | "getUserUploadQuota",
    skippedCalls: number,
    answerFound: boolean
): void => {
    const lookup = usersDatabase[name] as (id: string) => PromiseLike<unknown>;
    let calls: number = 0;

    jest.spyOn(usersDatabase, name).mockImplementation(((lookedUpId: string) => {
        const found: Promise<unknown> = Promise.resolve(lookup(lookedUpId));

        if (++calls <= skippedCalls) {
            return found;
        }

        return found.then(async (user: unknown) => {
            await deleteUser(lookedUpId);
            return answerFound ? user : lookup(lookedUpId);
        });
    }) as never);
};

const changeBeforePasswordUpdate = (change: () => Promise<unknown>): void => {
    const setPasswordIfUnset = usersDatabase.setPasswordIfUnset;

    jest.spyOn(usersDatabase, "setPasswordIfUnset").mockImplementation(((
        ...args: Parameters<typeof setPasswordIfUnset>
    ) => change().then(() => setPasswordIfUnset(...args))) as never);
};

const deleteAfterPasswordCheck = (id: string): void => {
    const verifyLoginPassword = passwordHelpers.verifyLoginPassword;

    jest.spyOn(passwordHelpers, "verifyLoginPassword").mockImplementation((async (
        ...args: Parameters<typeof verifyLoginPassword>
    ) => {
        const isPasswordCorrect: boolean = await verifyLoginPassword(...args);
        await deleteUser(id);
        return isPasswordCorrect;
    }) as never);
};

const resetPasswordOf = async (user: TestUser): Promise<string> => {
    await runRequestReset(user.email);
    const code: string = createEmailCode();
    const newPassword: string = randomHex(12);
    await updateStoredUser(user.id, (f) => [
        f("authentication.passwordReset.hash").set(
            hashEmailCode(usersDatabase.passwordResetScope(user.id, user.email), code)
        )
    ]);

    await request(TestData.apiURL)
        .post("/auth/password-reset/confirm")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email: user.email, code, newPassword })
        .expect(200);

    return newPassword;
};

const resetBefore = (
    name: "changePasswordAndSession" | "endReauthedSession",
    user: TestUser
): Promise<string> =>
    new Promise((resolve): void => {
        const write = usersDatabase[name] as (...args: unknown[]) => Promise<unknown>;

        jest.spyOn(usersDatabase, name).mockImplementation((async (...args: unknown[]) => {
            resolve(await resetPasswordOf(user));
            return write(...args);
        }) as never);
    });

const changeBeforeStore = <T extends object>(
    database: T,
    name: keyof T,
    change: () => Promise<unknown>
): void => {
    const store = database[name] as (...args: unknown[]) => Promise<unknown>;

    jest.spyOn(database, name as never).mockImplementationOnce(((...args: unknown[]) =>
        change().then(() => store(...args))) as never);
};

const suspend = (id: string) => usersDatabase.setUserSuspension(id, true);

const storeResetPassword = async (id: string, password: string) => {
    const salt: string = random();
    const hash: string = await passwordHelpers.hashPassword(salt, password, "127.0.0.1");

    return updateStoredUser(id, (f) => [
        f("authentication.salt").set(salt),
        f("authentication.password").set(hash),
        f("authentication.sessionToken").unset(),
        f("authentication.sessionExpiresAt").unset(),
        f("authentication.mfaChallenge").unset()
    ]);
};

const expectNothingStored = async (id: string): Promise<void> => {
    const stored = await storedAuthentication(id);

    expect(stored.sessionToken).toBeUndefined();
    expect(stored.mfaChallenge).toBeUndefined();
};

const loginStatus = async (user: TestUser, password: string): Promise<number> =>
    (
        await request(TestData.apiURL)
            .post("/auth/login")
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email: user.email, password })
    ).status;

describe("Vanished account tests", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    describe("POST /auth/login", (): void => {
        it("should answer 403 invalidCredentials without a session or device cookie when the account is deleted after the password check", async (): Promise<void> => {
            const user: TestUser = await createTestUser("vl");
            deleteAfterPasswordCheck(user.id);

            expectAnswer(
                await run(login, { body: { email: user.email, password: user.password } }),
                403,
                Responses.Authentication.invalidCredentials
            );
            expect(await usersDatabase.getUserById(user.id)).toBeNull();
        });

        describe("when the account changes before the login is stored", (): void => {
            const resetPassword: string = randomHex(12);

            const loginWith = (user: TestUser, password: string = user.password) =>
                run(login, { body: { email: user.email, password } });

            const userWith = async (mfa: boolean, legacy: boolean = false): Promise<TestUser> => {
                const user: TestUser = await createTestUser(mfa ? "vlm" : "vls");

                if (mfa) {
                    await turnOnEmailMfa(user);
                }

                if (legacy) {
                    const salt: string = random();
                    await updateStoredUser(user.id, (f) => [
                        f("authentication.salt").set(salt),
                        f("authentication.password").set(authentication(salt, user.password))
                    ]);
                }

                return user;
            };

            const storeOf = (mfa: boolean): [object, string] =>
                mfa ? [mfaDatabase, "setMfaChallenge"] : [usersDatabase, "setUserSession"];

            const expectLoggedIn = (
                { res, next }: { res: FakeResponse; next: jest.Mock },
                mfa: boolean
            ): void => {
                expect(next).not.toHaveBeenCalled();
                expect(res.status).toHaveBeenCalledWith(mfa ? 202 : 200);
                expect(res.cookie).toHaveBeenCalled();
            };

            it.each([false, true])(
                "should log in when nothing changes meanwhile (MFA %s)",
                async (mfa: boolean): Promise<void> => {
                    const user: TestUser = await userWith(mfa);

                    expectLoggedIn(await loginWith(user), mfa);
                }
            );

            it.each([false, true])(
                "should log in and upgrade a legacy hash when nothing changes meanwhile (MFA %s)",
                async (mfa: boolean): Promise<void> => {
                    const user: TestUser = await userWith(mfa, true);

                    expectLoggedIn(await loginWith(user), mfa);
                    expect((await storedAuthentication(user.id)).password).toMatch(
                        scryptHashPattern
                    );
                }
            );

            it.each([false, true])(
                "should answer 403 accountSuspended and store nothing when the account is suspended before the login is stored (MFA %s)",
                async (mfa: boolean): Promise<void> => {
                    const user: TestUser = await userWith(mfa);
                    const [database, name] = storeOf(mfa);
                    changeBeforeStore(database, name as never, () => suspend(user.id));

                    expectAnswer(
                        await loginWith(user),
                        403,
                        Responses.Authentication.accountSuspended
                    );
                    await expectNothingStored(user.id);
                }
            );

            it("should answer 403 accountSuspended when a legacy-hash account is suspended while its hash is upgraded", async (): Promise<void> => {
                const user: TestUser = await userWith(false, true);
                changeBeforeStore(usersDatabase, "replacePasswordHash", () => suspend(user.id));

                expectAnswer(await loginWith(user), 403, Responses.Authentication.accountSuspended);
                await expectNothingStored(user.id);
            });

            it.each([false, true])(
                "should log in both of two parallel logins that upgrade the same legacy hash (MFA %s)",
                async (mfa: boolean): Promise<void> => {
                    const user: TestUser = await userWith(mfa, true);
                    let first: { res: FakeResponse; next: jest.Mock };
                    changeBeforeStore(usersDatabase, "replacePasswordHash", async () => {
                        first = await loginWith(user);
                    });

                    expectLoggedIn(await loginWith(user), mfa);
                    expectLoggedIn(first, mfa);
                    expect((await storedAuthentication(user.id)).password).toMatch(
                        scryptHashPattern
                    );
                }
            );

            it("should answer 403 invalidCredentials and keep the reset password when a password reset lands before a legacy hash is upgraded", async (): Promise<void> => {
                const user: TestUser = await userWith(false, true);
                changeBeforeStore(usersDatabase, "replacePasswordHash", () =>
                    storeResetPassword(user.id, resetPassword)
                );

                expectAnswer(
                    await loginWith(user),
                    403,
                    Responses.Authentication.invalidCredentials
                );
                await expectNothingStored(user.id);

                expectLoggedIn(await loginWith(user, resetPassword), false);
            });

            it.each([false, true])(
                "should answer 403 invalidCredentials and store nothing when the password is reset before the login is stored, and log in with the reset password (MFA %s)",
                async (mfa: boolean): Promise<void> => {
                    const user: TestUser = await userWith(mfa);
                    const [database, name] = storeOf(mfa);
                    changeBeforeStore(database, name as never, () =>
                        storeResetPassword(user.id, resetPassword)
                    );

                    expectAnswer(
                        await loginWith(user),
                        403,
                        Responses.Authentication.invalidCredentials
                    );
                    await expectNothingStored(user.id);

                    expectLoggedIn(await loginWith(user, resetPassword), mfa);
                }
            );
        });
    });

    describe("POST /auth/passkey", (): void => {
        const passkeyLoginOf = async (user: TestUser) => {
            const authenticator: SoftwareAuthenticator = await registerPasskey(user);
            const options: supertest.Response = await request(TestData.apiURL)
                .post("/auth/passkey/options")
                .set("X-Forwarded-For", isolatedClientIp())
                .expect(200);
            const challengeId: string = []
                .concat(options.headers["set-cookie"] ?? [])
                .find((setCookie: string): boolean =>
                    setCookie.startsWith(`${passkeyLoginCookie}=`)
                )
                .split(";")[0]
                .slice(passkeyLoginCookie.length + 1);

            return () =>
                run(passkeyLogin, {
                    body: { response: authenticator.authenticate(options.body) },
                    cookies: { [passkeyLoginCookie]: challengeId }
                });
        };

        it.each(["usePasskey", "setUserSession"] as const)(
            "should answer 403 accountSuspended without a session when the account is suspended before %s",
            async (name: "usePasskey" | "setUserSession"): Promise<void> => {
                const user: TestUser = await createTestUser("vk");
                const logIn = await passkeyLoginOf(user);
                changeBeforeStore(usersDatabase, name, () => suspend(user.id));

                expectAnswer(await logIn(), 403, Responses.Authentication.accountSuspended);
                await expectNothingStored(user.id);
            }
        );
    });

    describe("POST /auth/register/verify", (): void => {
        const startVerification = async (): Promise<{ body: Record<string, string> }> => {
            const username: string = `v${randomHex(5)}`;
            const email: string = testEmailOf(username);
            const password: string = randomHex(12);

            await registerRequest({ username, email, password }).expect(202);

            return { body: { email, code: await setRegistrationCode(email), username, password } };
        };

        it.each([
            ["before its re-read", false],
            ["before the session is saved", true]
        ])(
            "should answer 403 when the new account is deleted %s",
            async (_: string, answerFound: boolean): Promise<void> => {
                const { body } = await startVerification();
                vanishDuringLookup("getUserById", 0, answerFound);

                expectAnswer(await run(verifyRegistration, { body }), 403, Responses.notLoggedIn);
                expect(await usersDatabase.getUserByEmail(body.email)).toBeNull();
            }
        );
    });

    describe("POST /user/password", (): void => {
        let githubUser: TestUser;

        const setPasswordOf = (user: TestUser) =>
            run(setPassword, {
                body: { password: randomHex(12) },
                identity: { _id: user.id },
                cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
            });

        beforeEach(async (): Promise<void> => {
            githubUser = await createTestUser("vp");
            await linkGithub(githubUser, true);
            await confirmGithub(githubUser);
        });

        it("should answer 403 notLoggedIn when the account is deleted while the password is hashed", async (): Promise<void> => {
            changeBeforePasswordUpdate(() => deleteUser(githubUser.id));

            expectAnswer(await setPasswordOf(githubUser), 403, Responses.notLoggedIn);
        });

        it("should answer 403 notLoggedIn when the session ends while the password is hashed", async (): Promise<void> => {
            changeBeforePasswordUpdate(() =>
                updateStoredUser(githubUser.id, (f) => [f("authentication.sessionToken").unset()])
            );

            expectAnswer(await setPasswordOf(githubUser), 403, Responses.notLoggedIn);
        });

        it.each([
            ["the account is suspended", (id: string) => suspend(id)],
            ["a password reset lands", (id: string) => storeResetPassword(id, randomHex(12))]
        ])(
            "should answer 403 notLoggedIn without a session when %s between setting the password and starting the session",
            async (_: string, change: (id: string) => Promise<unknown>): Promise<void> => {
                changeBeforeStore(usersDatabase, "setUserSession", () => change(githubUser.id));

                expectAnswer(await setPasswordOf(githubUser), 403, Responses.notLoggedIn);
                expect((await storedAuthentication(githubUser.id)).password).toBeTruthy();
                await expectNothingStored(githubUser.id);
            }
        );

        it("should answer 409 when another request sets the password first", async (): Promise<void> => {
            changeBeforePasswordUpdate(() =>
                updateStoredUser(githubUser.id, (f) => [
                    f("authentication.password").set("scrypt$other")
                ])
            );

            expectAnswer(await setPasswordOf(githubUser), 409, Responses.Users.passwordAlreadySet);
        });

        it("should answer 403 githubReauthRequired when the GitHub confirmation is cleared meanwhile", async (): Promise<void> => {
            changeBeforePasswordUpdate(() =>
                updateStoredUser(githubUser.id, (f) => [
                    f("authentication.githubVerifiedAt").unset()
                ])
            );

            expectAnswer(
                await setPasswordOf(githubUser),
                403,
                Responses.Users.githubReauthRequired(GITHUB_REAUTH_MINUTES)
            );
        });
    });

    describe("PATCH /user/password", (): void => {
        it("should answer 403 notLoggedIn and keep the reset password when a password reset lands before the change is stored", async (): Promise<void> => {
            const user: TestUser = await createTestUser("vpr");
            const requested: string = randomHex(12);
            const resetPassword: Promise<string> = resetBefore("changePasswordAndSession", user);

            expectAnswer(
                await run(changePassword, {
                    body: { currentPassword: user.password, newPassword: requested },
                    identity: { _id: user.id },
                    cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
                }),
                403,
                Responses.notLoggedIn
            );
            expect(await loginStatus(user, await resetPassword)).toBe(200);
            expect(await loginStatus(user, user.password)).toBe(403);
            expect(await loginStatus(user, requested)).toBe(403);
        });
    });

    describe("DELETE /user", (): void => {
        let githubUser: TestUser;

        const uploadFolderOf = (user: TestUser): string =>
            path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id);

        const deleteAccountOf = (user: TestUser) =>
            run(deleteAccount, {
                body: { username: user.username },
                cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
            });

        const expectContentKept = async (user: TestUser): Promise<void> => {
            expect(await usersDatabase.getUserById(user.id)).not.toBeNull();
            expect(await countOwnedContent(user.id)).toEqual({
                pastes: 1,
                shortUrls: 1,
                uploads: 1
            });
            expect(fs.existsSync(uploadFolderOf(user))).toBe(true);
        };

        const addContent = async (user: TestUser): Promise<void> => {
            await addPasteAndShortUrl(user.cookie);
            await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", user.cookie)
                .attach("file", testPng, "kept.png")
                .expect(201);
        };

        beforeEach(async (): Promise<void> => {
            githubUser = await createTestUser("vd");
            await linkGithub(githubUser, true);
            await confirmGithub(githubUser);
            await addContent(githubUser);
        });

        it("should answer 403 notLoggedIn and keep the content when a password reset lands after the password check", async (): Promise<void> => {
            const user: TestUser = await createTestUser("vdr");
            await addContent(user);
            const resetPassword: Promise<string> = resetBefore("endReauthedSession", user);

            expectAnswer(
                await run(deleteAccount, {
                    body: { password: user.password },
                    cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
                }),
                403,
                Responses.notLoggedIn
            );
            await expectContentKept(user);
            expect(await loginStatus(user, await resetPassword)).toBe(200);
        });

        const meanwhile: [string, Parameters<typeof updateStoredUser>[1]][] = [
            ["the session ends", (f) => [f("authentication.sessionToken").unset()]],
            [
                "the GitHub confirmation is cleared",
                (f) => [f("authentication.githubVerifiedAt").unset()]
            ],
            [
                "the GitHub confirmation ages out",
                (f) => [
                    f("authentication.githubVerifiedAt").set(
                        new Date(Date.now() - (GITHUB_REAUTH_MINUTES + 1) * 60 * 1000)
                    )
                ]
            ],
            ["a password is set", (f) => [f("authentication.password").set("scrypt$other")]]
        ];

        it.each(meanwhile)(
            "should answer 403 githubReauthRequiredToDelete and keep the content when %s meanwhile",
            async (_: string, change: Parameters<typeof updateStoredUser>[1]): Promise<void> => {
                const claimGithubVerification = usersDatabase.claimGithubVerification;
                jest.spyOn(usersDatabase, "claimGithubVerification").mockImplementation((async (
                    ...args: Parameters<typeof claimGithubVerification>
                ) => {
                    await updateStoredUser(githubUser.id, change);
                    return claimGithubVerification(...args);
                }) as never);

                expectAnswer(
                    await deleteAccountOf(githubUser),
                    403,
                    Responses.Users.githubReauthRequiredToDelete(GITHUB_REAUTH_MINUTES)
                );
                await expectContentKept(githubUser);
            }
        );

        it("should keep the account without its GitHub confirmation when removing the content fails", async (): Promise<void> => {
            const failure: Error = new Error("content removal failed");
            jest.spyOn(userUploadsDatabase, "deleteUploadsByUser").mockRejectedValue(failure);

            const { res, next } = await deleteAccountOf(githubUser);

            expect(next).toHaveBeenCalledWith(failure);
            expect(res.status).not.toHaveBeenCalled();
            expect(await usersDatabase.getUserById(githubUser.id)).not.toBeNull();
            expect(await isStored(githubUser.id, "authentication.githubVerifiedAt")).toBe(false);
        });
    });

    describe("POST /user/passkeys", (): void => {
        it("should answer 403 notLoggedIn when the session ends before the passkey is stored", async (): Promise<void> => {
            const user: TestUser = await createTestUser("vk");
            const challengeId: string = randomHex(16);
            const challenge: string = randomHex(16);
            const addPasskey = usersDatabase.addPasskey;

            await savePasskeyChallenge(
                hashSessionToken(challengeId),
                challenge,
                user.id,
                new Date(Date.now() + passkeyChallengeMs)
            );
            jest.spyOn(usersDatabase, "addPasskey").mockImplementation(((
                ...args: Parameters<typeof addPasskey>
            ) =>
                updateStoredUser(user.id, (f) => [f("authentication.sessionToken").unset()]).then(
                    () => addPasskey(...args)
                )) as never);

            expectAnswer(
                await run(finishPasskeyRegistration, {
                    body: {
                        name: "Laptop",
                        response: new SoftwareAuthenticator().register({
                            challenge,
                            user: { id: userHandleOf(user.id) }
                        })
                    },
                    identity: { _id: user.id },
                    cookies: {
                        [sessionCookie]: sessionTokenOf(user.cookie),
                        [passkeyRegistrationCookie]: challengeId
                    }
                }),
                403,
                Responses.notLoggedIn
            );
            expect((await storedAuthentication(user.id)).passkeys).toBeUndefined();
        });
    });

    describe("API keys", (): void => {
        const keyOf = () => ({
            id: randomHex(16),
            name: "seeded",
            hash: randomHex(32),
            hint: "abcd",
            scopes: ["pastes:read"],
            createdAt: new Date(),
            expiresAt: null as Date | null,
            lastUsedAt: null as Date | null
        });

        const loseReauthWithKeys = (
            name: "addApiKey" | "rotateApiKey",
            user: TestUser,
            keys: ReturnType<typeof keyOf>[],
            lostPath:
                | "authentication.sessionToken"
                | "authentication.githubVerifiedAt" = "authentication.sessionToken"
        ): void => {
            const update = apiKeysDatabase[name] as (...args: unknown[]) => Promise<unknown>;

            jest.spyOn(apiKeysDatabase, name).mockImplementation(((...args: unknown[]) =>
                updateStoredUser(user.id, (f) => [
                    f("authentication.apiKeys").set(keys),
                    f(lostPath).unset()
                ]).then(() => update(...args))) as never);
        };

        const requestOf = (user: TestUser, fields: object) => ({
            body: { password: user.password },
            identity: { _id: user.id, email: user.email },
            cookies: { [sessionCookie]: sessionTokenOf(user.cookie) },
            ...fields
        });

        it("should answer 403 notLoggedIn when the session ends as the account reaches the cap", async (): Promise<void> => {
            const user: TestUser = await createTestUser("vak");
            loseReauthWithKeys("addApiKey", user, Array.from({ length: API_KEYS_MAX }, keyOf));

            expectAnswer(
                await run(
                    createApiKey,
                    requestOf(user, {
                        body: { name: "CI", scopes: ["pastes:read"], password: user.password }
                    })
                ),
                403,
                Responses.notLoggedIn
            );
            expect((await storedAuthentication(user.id)).apiKeys).toHaveLength(API_KEYS_MAX);
        });

        it("should answer 403 githubReauthRequired when the GitHub confirmation is cleared as the account reaches the cap", async (): Promise<void> => {
            const user: TestUser = await createTestUser("vag");
            await linkGithub(user, true);
            await confirmGithub(user);
            loseReauthWithKeys(
                "addApiKey",
                user,
                Array.from({ length: API_KEYS_MAX }, keyOf),
                "authentication.githubVerifiedAt"
            );

            expectAnswer(
                await run(
                    createApiKey,
                    requestOf(user, { body: { name: "CI", scopes: ["pastes:read"] } })
                ),
                403,
                Responses.ApiKeys.githubReauthRequired(GITHUB_REAUTH_MINUTES)
            );
            expect((await storedAuthentication(user.id)).apiKeys).toHaveLength(API_KEYS_MAX);
        });

        it("should answer 403 notLoggedIn when the session ends as the key is deleted", async (): Promise<void> => {
            const user: TestUser = await createTestUser("var");
            const key = keyOf();
            await updateStoredUser(user.id, (f) => [f("authentication.apiKeys").set([key])]);
            loseReauthWithKeys("rotateApiKey", user, []);

            expectAnswer(
                await run(rotateApiKeyById, requestOf(user, { params: { id: key.id } })),
                403,
                Responses.notLoggedIn
            );
        });
    });

    describe("PATCH /user/email", (): void => {
        let changer: TestUser;
        let sendMail: jest.SpyInstance;

        const newChange = (): usersDatabase.EmailChange => {
            const email: string = testEmailOf(`ce${randomHex(5)}`);

            return {
                email,
                ...issueEmailCode(
                    usersDatabase.emailChangeScope(changer.id, email),
                    createEmailCode(),
                    EMAIL_CHANGE_CODE_MINUTES
                )
            };
        };

        const changeEmailOf = (user: TestUser) =>
            run(changeEmail, {
                body: { email: testEmailOf(`ce${randomHex(5)}`), password: user.password },
                identity: { _id: user.id },
                cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
            });

        const storedChange = async (user: TestUser) =>
            (await storedAuthentication(user.id)).emailChange;

        const storedPasswordHash = async (user: TestUser): Promise<string> =>
            (await storedAuthentication(user.id)).password;

        const changeBeforeStore = (change: () => Promise<unknown>): void => {
            const setEmailChange = usersDatabase.setEmailChange;

            jest.spyOn(usersDatabase, "setEmailChange").mockImplementation(((
                ...args: Parameters<typeof setEmailChange>
            ) => change().then(() => setEmailChange(...args))) as never);
        };

        const otherPasswordHash = (): string => `scrypt$${randomHex(8)}`;

        beforeEach(async (): Promise<void> => {
            changer = await createTestUser("vc");
            sendMail = jest.spyOn(mail, "sendMail").mockResolvedValue();
        });

        it("should answer 202 and store the change when nothing changes meanwhile", async (): Promise<void> => {
            const { res, next } = await changeEmailOf(changer);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(202);
            expect(await storedChange(changer)).toBeDefined();
            expect(sendMail).toHaveBeenCalledTimes(1);
        });

        it.each([
            [
                "a password reset completes",
                (id: string) =>
                    updateStoredUser(id, (f) => [
                        f("authentication.password").set(otherPasswordHash()),
                        f("authentication.sessionToken").unset(),
                        f("authentication.sessionExpiresAt").unset()
                    ])
            ],
            ["the user is suspended", (id: string) => usersDatabase.setUserSuspension(id, true)],
            [
                "the session ends",
                (id: string) =>
                    updateStoredUser(id, (f) => [f("authentication.sessionToken").unset()])
            ],
            [
                "the password changes",
                (id: string) =>
                    updateStoredUser(id, (f) => [
                        f("authentication.password").set(otherPasswordHash())
                    ])
            ]
        ])(
            "should answer 403 notLoggedIn and store and mail nothing when %s before the change is stored",
            async (_: string, change: (id: string) => Promise<unknown>): Promise<void> => {
                changeBeforeStore(() => change(changer.id));

                expectAnswer(await changeEmailOf(changer), 403, Responses.notLoggedIn);
                expect(await storedChange(changer)).toBeUndefined();
                expect(sendMail).not.toHaveBeenCalled();
            }
        );

        it("should answer 429 and keep the waiting change within the cooldown", async (): Promise<void> => {
            const waiting = newChange();
            await updateStoredUser(changer.id, (f) => [
                f("authentication.emailChange").set({ ...waiting })
            ]);

            const { res, next } = await changeEmailOf(changer);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ reason: "resendCooldown" })
            );
            expect((await storedChange(changer)).hash).toBe(waiting.hash);
            expect(sendMail).not.toHaveBeenCalled();
        });

        describe("setEmailChange", (): void => {
            const storeChange = (sessionToken: string, passwordHash: string) =>
                usersDatabase.setEmailChange(
                    changer.id,
                    sessionToken,
                    passwordHash,
                    newChange(),
                    new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000)
                );

            it("should store the change for the session and password it was checked against", async (): Promise<void> => {
                expect(
                    await storeChange(
                        sessionTokenOf(changer.cookie),
                        await storedPasswordHash(changer)
                    )
                ).not.toBeNull();
                expect(await storedChange(changer)).toBeDefined();
            });

            it("should store nothing for a session that is not the stored one", async (): Promise<void> => {
                expect(
                    await storeChange(randomHex(32), await storedPasswordHash(changer))
                ).toBeNull();
                expect(await storedChange(changer)).toBeUndefined();
            });

            it("should store nothing for a password hash that is not the stored one", async (): Promise<void> => {
                expect(
                    await storeChange(sessionTokenOf(changer.cookie), otherPasswordHash())
                ).toBeNull();
                expect(await storedChange(changer)).toBeUndefined();
            });

            it("should store nothing for an expired session", async (): Promise<void> => {
                const expired: string = await storeSession(
                    changer,
                    new Date(Date.now() - SESSION_MAX_AGE_MS)
                );

                expect(
                    await storeChange(sessionTokenOf(expired), await storedPasswordHash(changer))
                ).toBeNull();
                expect(await storedChange(changer)).toBeUndefined();
            });

            it("should store nothing for a suspended user", async (): Promise<void> => {
                await usersDatabase.setUserSuspension(changer.id, true);
                const suspendedSession: string = await storeSession(changer);

                expect(
                    await storeChange(
                        sessionTokenOf(suspendedSession),
                        await storedPasswordHash(changer)
                    )
                ).toBeNull();
                expect(await storedChange(changer)).toBeUndefined();
            });
        });
    });

    describe("admin endpoints", (): void => {
        let user: TestUser;

        beforeEach(async (): Promise<void> => {
            user = await createTestUser("va");
        });

        it("should answer 404 from PATCH /admin/users/:id/upload-quota when the user is deleted before the re-read", async (): Promise<void> => {
            vanishDuringLookup("getUserUploadQuota", 1, false);

            expectAnswer(
                await run(updateUserUploadQuota, {
                    params: { id: user.id },
                    body: { quotaBytes: 1024 }
                }),
                404,
                Responses.Admin.userNotFound
            );
        });

        it("should answer 404 from PATCH /admin/users/:id/suspension when the user is deleted before the re-read", async (): Promise<void> => {
            vanishDuringLookup("getUserUploadQuota", 1, false);

            expectAnswer(
                await run(updateUserSuspension, {
                    params: { id: user.id },
                    body: { suspended: true }
                }),
                404,
                Responses.Admin.userNotFound
            );
        });

        it("should answer 404 from PATCH /admin/users/:id when the user is deleted before the re-read", async (): Promise<void> => {
            vanishDuringLookup("getUserUploadQuota", 0, false);

            expectAnswer(
                await run(renameUser, {
                    params: { id: user.id },
                    body: { username: `r${randomHex(5)}` }
                }),
                404,
                Responses.Admin.userNotFound
            );
        });

        it("should answer 404 from PATCH /admin/users/:id when the user is deleted before the rename is saved", async (): Promise<void> => {
            vanishDuringLookup("getUserById", 0, true);

            expectAnswer(
                await run(renameUser, {
                    params: { id: user.id },
                    body: { username: `r${randomHex(5)}` }
                }),
                404,
                Responses.Admin.userNotFound
            );
        });
    });
});
