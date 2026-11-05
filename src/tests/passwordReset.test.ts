import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    UserModel,
    emailChangeScope,
    passwordResetLinkScope,
    passwordResetScope,
    setPasswordReset
} from "../database/users";
import { authentication } from "../helpers";
import {
    CODE_FAILURES_PER_DAY,
    EMAIL_CODE_MAX_ATTEMPTS,
    EMAIL_CODE_RESEND_SECONDS,
    createEmailCode,
    hashEmailCode,
    issueEmailCode
} from "../helpers/emailCodes";
import { createOauthSecret } from "../helpers/github";
import * as mail from "../helpers/mail";
import { FAILED_ATTEMPTS_PER_ACCOUNT } from "../middlewares/rateLimit";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    randomHex,
    scryptHashPattern,
    storedAuthentication,
    testEmailOf
} from "./helpers/testUsers";
import { runRequestReset } from "./helpers/passwordReset";

const requestReset = (email: unknown): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/password-reset")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email });

const confirmReset = (body: Record<string, unknown>): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/password-reset/confirm")
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const storedReset = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.passwordReset").lean())
        .authentication?.passwordReset;

const setResetCode = async (user: TestUser, email: string = user.email): Promise<string> => {
    const code: string = createEmailCode();

    await UserModel.updateOne(
        { _id: user.id },
        {
            $set: {
                "authentication.passwordReset.hash": hashEmailCode(
                    passwordResetScope(user.id, email),
                    code
                )
            }
        }
    );

    return code;
};

const changeEmail = async (user: TestUser, email: string): Promise<void> => {
    await request(TestData.apiURL)
        .patch("/user/email")
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email, password: user.password })
        .expect(202);

    const code: string = createEmailCode();
    await UserModel.updateOne(
        { _id: user.id },
        {
            $set: {
                "authentication.emailChange.hash": hashEmailCode(
                    emailChangeScope(user.id, email),
                    code
                )
            }
        }
    );

    await request(TestData.apiURL)
        .post("/user/email/confirm")
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ code })
        .expect(200);
};

const confirmLink = (body: Record<string, unknown>): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/password-reset/confirm-link")
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const storedLinks = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.passwordResetLinks").lean())
        .authentication?.passwordResetLinks;

const expectNoStoredSession = async (user: TestUser): Promise<void> => {
    const { authentication } = await UserModel.findById(user.id)
        .select("+authentication.sessionToken +authentication.sessionExpiresAt")
        .lean();

    expect(authentication).not.toHaveProperty("sessionToken");
    expect(authentication).not.toHaveProperty("sessionExpiresAt");
};

const passCooldown = async (user: TestUser): Promise<void> => {
    await UserModel.updateOne(
        { _id: user.id },
        {
            $set: {
                "authentication.passwordReset.sentAt": new Date(
                    Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000
                )
            }
        }
    );
};

const plantResetLink = async (
    user: TestUser,
    expiresAt: Date = new Date(Date.now() + 30 * 60 * 1000)
): Promise<string> => {
    const secret: string = createOauthSecret();

    await UserModel.updateOne(
        { _id: user.id },
        {
            $push: {
                "authentication.passwordResetLinks": {
                    hash: authentication(passwordResetLinkScope(user.id), secret),
                    expiresAt
                }
            }
        }
    );

    return `${user.id}.${secret}`;
};

const resetSent = { status: 200, body: { message: Responses.Authentication.passwordResetSent } };

const mailedResetLink = async (email: string): Promise<string> => {
    const sendMail: jest.SpyInstance = jest.spyOn(mail, "sendMail").mockResolvedValue();

    await runRequestReset(email);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [[sent]] = sendMail.mock.calls;
    sendMail.mockRestore();

    return sent.text.match(/^https?:\/\/\S+\/reset-password#token=\S+$/m)[0];
};

const tokenOf = (link: string): string => link.split("#token=")[1];

const otherCode = (code: string): string => (code === "000000" ? "000001" : "000000");

const loginStatus = async (email: string, password: string): Promise<number> =>
    (await request(TestData.apiURL).post("/auth/login").send({ email, password })).status;

describe("Password Reset API Tests", (): void => {
    describe("POST /auth/password-reset", (): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("pr");
        });

        test.each([
            ["no e-mail", undefined],
            ["an empty e-mail", ""],
            ["a numeric e-mail", 5]
        ])("should answer 400 to %s", async (_: string, email: unknown): Promise<void> => {
            const response: supertest.Response = await requestReset(email).expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.missingEmail);
        });

        it("should answer the same 200 to an address without an account", async (): Promise<void> => {
            const response: supertest.Response = await requestReset(
                testEmailOf(`pr${randomHex(5)}`)
            ).expect(200);

            expect(response.body).toEqual({ message: Responses.Authentication.passwordResetSent });
        });

        it("should answer an account's address like an address without an account", async (): Promise<void> => {
            const account: TestUser = await createTestUser("pr");

            const existing: supertest.Response = await requestReset(account.email);
            const unknown: supertest.Response = await requestReset(
                testEmailOf(`pr${randomHex(5)}`)
            );

            expect([existing.status, existing.body]).toEqual([unknown.status, unknown.body]);
            expect(existing.status).toBe(200);
        });

        it("should store a hashed code for an account, whatever the case", async (): Promise<void> => {
            expect(await runRequestReset(` ${user.email.toUpperCase()} `)).toEqual(resetSent);

            const reset = await storedReset(user);
            expect(reset).toMatchObject({ attempts: 0 });
            expect(reset.hash).toMatch(/^[0-9a-f]{64}$/);
            expect(reset.expiresAt.getTime() - reset.sentAt.getTime()).toBe(30 * 60 * 1000);
            expect(await storedLinks(user)).toEqual([
                { hash: expect.stringMatching(/^[0-9a-f]{64}$/), expiresAt: reset.expiresAt }
            ]);
        });

        it("should keep the code within the cooldown and answer the same 200", async (): Promise<void> => {
            const { hash } = await storedReset(user);

            expect(await runRequestReset(user.email)).toEqual(resetSent);
            expect((await storedReset(user)).hash).toBe(hash);
        });

        it("should replace the code after the cooldown and add a link", async (): Promise<void> => {
            const { hash } = await storedReset(user);
            const [link] = await storedLinks(user);
            await passCooldown(user);

            await runRequestReset(user.email);

            expect((await storedReset(user)).hash).not.toBe(hash);
            expect(await storedLinks(user)).toEqual([
                link,
                { hash: expect.not.stringMatching(link.hash), expiresAt: expect.any(Date) }
            ]);
        });

        it("should keep sending codes to an address locked out by wrong codes", async (): Promise<void> => {
            const lockedUser: TestUser = await createTestUser("pr");
            const guess = { email: lockedUser.email, code: "123456", newPassword: randomHex(12) };

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await confirmReset(guess).expect(400);
            }
            await confirmReset(guess).expect(429);

            expect(await runRequestReset(lockedUser.email)).toEqual(resetSent);
            expect((await storedReset(lockedUser)).hash).toMatch(/^[0-9a-f]{64}$/);
        }, 25000);

        it("should not show the code in GET /user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", user.cookie)
                .expect(200);

            expect(JSON.stringify(response.body)).not.toContain("passwordReset");
        });
    });

    describe("POST /auth/password-reset/confirm", (): void => {
        const newPassword: string = randomHex(12);

        const userWithCode = async (): Promise<[TestUser, string]> => {
            const user: TestUser = await createTestUser("prc");
            await runRequestReset(user.email);
            return [user, await setResetCode(user)];
        };

        test.each([
            ["nothing", {}],
            ["no code", { email: "x", newPassword: "password123" }],
            ["no new password", { email: "x", code: "123456" }],
            ["a numeric code", { email: "x", code: 123456, newPassword: "password123" }]
        ])("should answer 400 to %s", async (_: string, body: object): Promise<void> => {
            const response: supertest.Response = await confirmReset({
                ...body,
                ...("email" in body ? { email: testEmailOf(`prc${randomHex(5)}`) } : {})
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingPasswordResetFields
            );
        });

        it("should answer 400 to a too short password without using up a try", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code,
                newPassword: "short"
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.passwordTooShort
            );
            expect(await storedReset(user)).toMatchObject({ attempts: 0 });
        });

        it("should set the new password, end every session and use up the code", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const response: supertest.Response = await confirmReset({
                email: user.email.toUpperCase(),
                code: `${code.slice(0, 3)} ${code.slice(3)}`,
                newPassword
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Authentication.passwordResetSuccess
            });
            expect(response.headers["set-cookie"]).toBeUndefined();
            expect(await storedReset(user)).toBeUndefined();
            await expectNoStoredSession(user);
            expect(await storedLinks(user)).toBeUndefined();
            expect((await storedAuthentication(user.id)).password).toMatch(scryptHashPattern);
            expect(await loginStatus(user.email, user.password)).toBe(403);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
            await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(403);

            await confirmReset({ email: user.email, code, newPassword }).expect(400);
        });

        it("should answer 400 to a wrong code and still take the right one", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code: otherCode(code),
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            expect(await storedReset(user)).toMatchObject({ attempts: 1 });
            expect(await loginStatus(user.email, user.password)).toBe(200);

            await confirmReset({ email: user.email, code, newPassword }).expect(200);
        });

        it(`should void the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong attempts`, async (): Promise<void> => {
            const [user, code] = await userWithCode();

            for (let attempt = 0; attempt < EMAIL_CODE_MAX_ATTEMPTS; attempt++) {
                await confirmReset({
                    email: user.email,
                    code: otherCode(code),
                    newPassword
                }).expect(400);
            }

            await confirmReset({ email: user.email, code, newPassword }).expect(400);
            expect(await loginStatus(user.email, user.password)).toBe(200);
        });

        it("should answer 400 to an expired code", async (): Promise<void> => {
            const [user, code] = await userWithCode();
            await UserModel.updateOne(
                { _id: user.id },
                { $set: { "authentication.passwordReset.expiresAt": new Date(Date.now() - 1000) } }
            );

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code,
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should void the code when the e-mail changes", async (): Promise<void> => {
            const [user, code] = await userWithCode();
            const newEmail: string = testEmailOf(`prc${randomHex(5)}`);
            await changeEmail(user, newEmail);

            const response: supertest.Response = await confirmReset({
                email: newEmail,
                code,
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            expect(await storedReset(user)).toBeUndefined();
            expect(await storedLinks(user)).toBeUndefined();
            expect(await loginStatus(newEmail, user.password)).toBe(200);
        });

        it("should answer 400 to a code issued for the address before the change", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prc");
            const newEmail: string = testEmailOf(`prc${randomHex(5)}`);
            await changeEmail(user, newEmail);
            await runRequestReset(newEmail);
            const code: string = await setResetCode(user);

            const response: supertest.Response = await confirmReset({
                email: newEmail,
                code,
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            expect(await loginStatus(newEmail, user.password)).toBe(200);
        });

        it("should answer 400 to an address without a code", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prc");

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code: "123456",
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should accept the code only once from parallel requests", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 4 }, (_: unknown, index: number): supertest.Test =>
                    confirmReset({ email: user.email, code, newPassword: `${newPassword}${index}` })
                )
            );

            const accepted: number[] = responses
                .map((response: supertest.Response, index: number): number =>
                    response.status === 200 ? index : -1
                )
                .filter((index: number): boolean => index >= 0);

            expect(accepted).toHaveLength(1);
            expect(await loginStatus(user.email, `${newPassword}${accepted[0]}`)).toBe(200);
        });

        it("should give a GitHub-only account a password and confirm its e-mail", async (): Promise<void> => {
            const [user, code] = await userWithCode();
            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin: "gh" },
                    $unset: {
                        "authentication.password": 1,
                        "authentication.salt": 1,
                        "authentication.emailVerifiedAt": 1
                    }
                }
            );
            expect(await loginStatus(user.email, user.password)).toBe(403);

            await confirmReset({ email: user.email, code, newPassword }).expect(200);

            const loginResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: newPassword })
                .expect(200);
            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", loginResponse.headers["set-cookie"][0])
                .expect(200);

            expect(userResponse.body).toMatchObject({
                hasPassword: true,
                emailVerified: true,
                githubLogin: "gh"
            });
        });
    });

    describe("POST /auth/password-reset/confirm-link", (): void => {
        const newPassword: string = randomHex(12);

        const userWithLink = async (): Promise<[TestUser, string]> => {
            const user: TestUser = await createTestUser("prl");
            return [user, await plantResetLink(user)];
        };

        test.each([
            ["nothing", {}],
            ["no token", { newPassword: "password123" }],
            ["no new password", { token: "x" }],
            ["a numeric token", { token: 5, newPassword: "password123" }]
        ])(
            "should answer 400 to %s",
            async (_: string, body: Record<string, unknown>): Promise<void> => {
                const response: supertest.Response = await confirmLink(body).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.missingPasswordResetLinkFields
                );
            }
        );

        it("should send a link with the code that sets the new password", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const link: string = await mailedResetLink(user.email);

            expect(link.startsWith(`${process.env.BASE_SITE_URL || "https://vb2007.hu"}/`)).toBe(
                true
            );

            const response: supertest.Response = await confirmLink({
                token: tokenOf(link),
                newPassword
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Authentication.passwordResetSuccess
            });
            expect(await loginStatus(user.email, newPassword)).toBe(200);
        });

        it("should take the link while the address is locked out of codes", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const link: string = await mailedResetLink(user.email);
            const code: string = await setResetCode(user);

            for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
                await confirmReset({
                    email: user.email,
                    code: otherCode(code),
                    newPassword
                }).expect(400);
            }
            await confirmReset({ email: user.email, code, newPassword }).expect(429);

            await confirmLink({ token: tokenOf(link), newPassword }).expect(200);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
        }, 25000);

        it(`should take the link while the address is over ${CODE_FAILURES_PER_DAY} wrong codes a day`, async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const link: string = await mailedResetLink(user.email);
            const code: string = await setResetCode(user);
            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.passwordResetFailures": {
                            count: CODE_FAILURES_PER_DAY,
                            since: new Date()
                        }
                    }
                }
            );

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code,
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            await confirmLink({ token: tokenOf(link), newPassword }).expect(200);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
        });

        it("should end every session and use up the link and the code", async (): Promise<void> => {
            const [user, token] = await userWithLink();
            await runRequestReset(user.email);
            const code: string = await setResetCode(user);

            await confirmLink({ token, newPassword }).expect(200);

            expect(await storedReset(user)).toBeUndefined();
            expect(await storedLinks(user)).toBeUndefined();
            await expectNoStoredSession(user);
            expect(await loginStatus(user.email, user.password)).toBe(403);
            await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(403);

            const response: supertest.Response = await confirmLink({
                token,
                newPassword: randomHex(12)
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.invalidPasswordResetLink
            );
            await confirmReset({ email: user.email, code, newPassword }).expect(400);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
        });

        it("should keep an older link working after a newer reset request", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const olderLink: string = await mailedResetLink(user.email);
            await passCooldown(user);
            const newerLink: string = await mailedResetLink(user.email);

            expect(newerLink).not.toBe(olderLink);
            expect(await storedLinks(user)).toHaveLength(2);

            await confirmLink({ token: tokenOf(olderLink), newPassword }).expect(200);
            await confirmLink({ token: tokenOf(newerLink), newPassword }).expect(400);
        });

        it("should void the link and the code when the password is changed", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const link: string = await mailedResetLink(user.email);
            const code: string = await setResetCode(user);

            await request(TestData.apiURL)
                .patch("/user/password")
                .set("Cookie", user.cookie)
                .send({ currentPassword: user.password, newPassword })
                .expect(200);

            expect(await storedReset(user)).toBeUndefined();
            expect(await storedLinks(user)).toBeUndefined();
            await confirmLink({ token: tokenOf(link), newPassword: randomHex(12) }).expect(400);
            await confirmReset({ email: user.email, code, newPassword: randomHex(12) }).expect(400);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
        });

        it("should void the link and the code when a GitHub-only account sets a password", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            await linkGithub(user, true);
            await confirmGithub(user);
            const link: string = await mailedResetLink(user.email);
            const code: string = await setResetCode(user);

            await request(TestData.apiURL)
                .post("/user/password")
                .set("Cookie", user.cookie)
                .send({ password: newPassword })
                .expect(200);

            expect(await storedReset(user)).toBeUndefined();
            expect(await storedLinks(user)).toBeUndefined();
            await confirmLink({ token: tokenOf(link), newPassword: randomHex(12) }).expect(400);
            await confirmReset({ email: user.email, code, newPassword: randomHex(12) }).expect(400);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
        });

        it("should not store a code or link for an address the account no longer has", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const staleEmail: string = testEmailOf(`prl${randomHex(5)}`);
            const code = issueEmailCode(passwordResetScope(user.id, staleEmail), "123456", 30);

            const previous = await setPasswordReset(
                user.id,
                staleEmail,
                code,
                { hash: randomHex(32), expiresAt: code.expiresAt },
                30,
                new Date()
            );

            expect(previous).toBeNull();
            expect(await storedReset(user)).toBeUndefined();
            expect(await storedLinks(user)).toBeUndefined();
        });

        it("should drop expired links on the next reset request", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            await plantResetLink(user, new Date(Date.now() - 1000));
            const link: string = await mailedResetLink(user.email);

            expect(await storedLinks(user)).toHaveLength(1);
            await confirmLink({ token: tokenOf(link), newPassword }).expect(200);
        });

        it("should not keep a link that wasn't mailed", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const link: string = await mailedResetLink(user.email);
            await passCooldown(user);
            jest.spyOn(console, "error").mockImplementation((): void => undefined);
            jest.spyOn(mail, "sendMail").mockRejectedValue(new Error("connect ECONNREFUSED"));

            await runRequestReset(user.email);
            jest.restoreAllMocks();

            expect(await storedLinks(user)).toHaveLength(1);
            await confirmLink({ token: tokenOf(link), newPassword }).expect(200);
        });

        it("should answer 400 to a too short password without using up the link", async (): Promise<void> => {
            const [user, token] = await userWithLink();

            const response: supertest.Response = await confirmLink({
                token,
                newPassword: "short"
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.passwordTooShort
            );
            await confirmLink({ token, newPassword }).expect(200);
        });

        it("should answer 400 to an expired link", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prl");
            const token: string = await plantResetLink(user, new Date(Date.now() - 1000));

            const response: supertest.Response = await confirmLink({ token, newPassword }).expect(
                400
            );

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.invalidPasswordResetLink
            );
            expect(await loginStatus(user.email, user.password)).toBe(200);
        });

        it("should answer 400 to a wrong secret or another account's id", async (): Promise<void> => {
            const [user, token] = await userWithLink();
            const [other] = await userWithLink();
            const secret: string = token.split(".")[1];

            for (const wrongToken of [
                `${user.id}.${createOauthSecret()}`,
                `${other.id}.${secret}`
            ]) {
                const response: supertest.Response = await confirmLink({
                    token: wrongToken,
                    newPassword
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.invalidPasswordResetLink
                );
            }

            expect(await loginStatus(user.email, user.password)).toBe(200);
            expect(await loginStatus(other.email, other.password)).toBe(200);
            await confirmLink({ token, newPassword }).expect(200);
        });

        test.each([
            ["no separator", `${randomHex(12)}${createOauthSecret()}`],
            ["a malformed id", `${randomHex(11)}.${createOauthSecret()}`],
            ["a short secret", `${randomHex(12)}.${randomHex(8)}`],
            ["an extra part", `${randomHex(12)}.${createOauthSecret()}.x`]
        ])(
            "should answer 400 to a token with %s",
            async (_: string, token: string): Promise<void> => {
                const response: supertest.Response = await confirmLink({
                    token,
                    newPassword
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.invalidPasswordResetLink
                );
            }
        );

        it("should accept the link only once from parallel requests", async (): Promise<void> => {
            const [user, token] = await userWithLink();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 4 }, (_: unknown, index: number): supertest.Test =>
                    confirmLink({ token, newPassword: `${newPassword}${index}` })
                )
            );

            const accepted: number[] = responses
                .map((response: supertest.Response, index: number): number =>
                    response.status === 200 ? index : -1
                )
                .filter((index: number): boolean => index >= 0);

            expect(accepted).toHaveLength(1);
            expect(await loginStatus(user.email, `${newPassword}${accepted[0]}`)).toBe(200);
        });

        it("should not show the links in GET /user", async (): Promise<void> => {
            const [user] = await userWithLink();

            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", user.cookie)
                .expect(200);

            expect(JSON.stringify(response.body)).not.toContain("passwordReset");
        });
    });
});
