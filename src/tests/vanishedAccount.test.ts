import express from "express";
import mongoose from "mongoose";
import { Responses } from "../constants/responses";
import {
    EMAIL_CHANGE_CODE_MINUTES,
    EMAIL_CODE_RESEND_SECONDS,
    GITHUB_REAUTH_MINUTES,
    SESSION_MAX_AGE_MS
} from "../constants/limits";
import { renameUser, updateUserSuspension, updateUserUploadQuota } from "../controllers/admin";
import { login, verifyRegistration } from "../controllers/authentication";
import { changeEmail, setPassword } from "../controllers/users";
import * as usersDatabase from "../database/users";
import { UserModel } from "../database/users";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    linkGithub,
    randomHex,
    registerRequest,
    sessionTokenOf,
    setRegistrationCode,
    storeSession,
    testEmailOf
} from "./helpers/testUsers";
import { createEmailCode, issueEmailCode } from "../helpers/emailCodes";
import * as mail from "../helpers/mail";
import * as passwordHelpers from "../helpers/password";
import { sessionCookie } from "../helpers/session";

interface FakeResponse {
    status: jest.Mock;
    json: jest.Mock;
    set: jest.Mock;
    cookie: jest.Mock;
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

const deleteUser = (id: unknown) => UserModel.deleteOne({ _id: id });

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
            expect(await UserModel.countDocuments({ _id: user.id })).toBe(0);
        });
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
                expect(await UserModel.countDocuments({ email: body.email })).toBe(0);
            }
        );
    });

    describe("POST /user/password", (): void => {
        let githubUser: TestUser;

        const setPasswordOf = (user: TestUser) =>
            run(setPassword, {
                body: { password: randomHex(12) },
                identity: { _id: new mongoose.Types.ObjectId(user.id) },
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
                UserModel.updateOne(
                    { _id: githubUser.id },
                    { $unset: { "authentication.sessionToken": 1 } }
                )
            );

            expectAnswer(await setPasswordOf(githubUser), 403, Responses.notLoggedIn);
        });

        it("should answer 409 when another request sets the password first", async (): Promise<void> => {
            changeBeforePasswordUpdate(() =>
                UserModel.updateOne(
                    { _id: githubUser.id },
                    { $set: { "authentication.password": "scrypt$other" } }
                )
            );

            expectAnswer(await setPasswordOf(githubUser), 409, Responses.Users.passwordAlreadySet);
        });

        it("should answer 403 githubReauthRequired when the GitHub confirmation is cleared meanwhile", async (): Promise<void> => {
            changeBeforePasswordUpdate(() =>
                UserModel.updateOne(
                    { _id: githubUser.id },
                    { $unset: { "authentication.githubVerifiedAt": 1 } }
                )
            );

            expectAnswer(
                await setPasswordOf(githubUser),
                403,
                Responses.Users.githubReauthRequired(GITHUB_REAUTH_MINUTES)
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
                identity: { _id: new mongoose.Types.ObjectId(user.id) },
                cookies: { [sessionCookie]: sessionTokenOf(user.cookie) }
            });

        const storedChange = async (user: TestUser) =>
            (await UserModel.findById(user.id).select("+authentication.emailChange").lean())
                .authentication?.emailChange;

        const storedPasswordHash = async (user: TestUser): Promise<string> =>
            (await UserModel.findById(user.id).select("+authentication.password").lean())
                .authentication.password;

        const changeBeforeStore = (change: () => Promise<unknown>): void => {
            const setEmailChange = usersDatabase.setEmailChange;

            jest.spyOn(usersDatabase, "setEmailChange").mockImplementation(((
                ...args: Parameters<typeof setEmailChange>
            ) => change().then(() => setEmailChange(...args))) as never);
        };

        const otherPasswordHash = (): string => `scrypt$${randomHex(8)}`;

        const replacePassword = () => ({
            "authentication.password": otherPasswordHash()
        });

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
                    UserModel.updateOne(
                        { _id: id },
                        {
                            $set: replacePassword(),
                            $unset: {
                                "authentication.sessionToken": 1,
                                "authentication.sessionExpiresAt": 1
                            }
                        }
                    )
            ],
            ["the user is suspended", (id: string) => usersDatabase.setUserSuspension(id, true)],
            [
                "the session ends",
                (id: string) =>
                    UserModel.updateOne(
                        { _id: id },
                        { $unset: { "authentication.sessionToken": 1 } }
                    )
            ],
            [
                "the password changes",
                (id: string) => UserModel.updateOne({ _id: id }, { $set: replacePassword() })
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
            await UserModel.updateOne(
                { _id: changer.id },
                { $set: { "authentication.emailChange": waiting } }
            );

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
