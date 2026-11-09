import express from "express";
import mongoose from "mongoose";
import { Responses } from "../constants/responses";
import { GITHUB_REAUTH_MINUTES } from "../constants/limits";
import { renameUser, updateUserSuspension, updateUserUploadQuota } from "../controllers/admin";
import { verifyRegistration } from "../controllers/authentication";
import { setPassword } from "../controllers/users";
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
    testEmailOf
} from "./helpers/testUsers";
import { sessionCookie } from "../helpers/session";

interface FakeResponse {
    status: jest.Mock;
    json: jest.Mock;
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

describe("Vanished account tests", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
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
