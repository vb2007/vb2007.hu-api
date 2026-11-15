import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    CODE_FAILURES_PER_DAY,
    GITHUB_REAUTH_MINUTES,
    MFA_CHALLENGE_ATTEMPTS,
    MFA_EMAILS_PER_DAY
} from "../constants/limits";
import { UserModel, emailChangeScope, passwordResetScope } from "../database/users";
import { createEmailCode, hashEmailCode } from "../helpers/emailCodes";
import { deviceCookie } from "../helpers/deviceCookie";
import { mfaCookie } from "../helpers/mfa";
import { sessionCookie } from "../helpers/session";
import { createOauthSecret } from "../helpers/github";
import { hashSessionToken } from "../helpers";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    randomHex,
    testEmailOf
} from "./helpers/testUsers";
import { mailedMfaEmail, mfaCookieOf, runSendMfaEmail, turnOnEmailMfa } from "./helpers/mfa";
import { runRequestReset } from "./helpers/passwordReset";
import * as mail from "../helpers/mail";

const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

const loginRequest = (user: TestUser): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email: user.email, password: user.password });

const startMfaLogin = async (user: TestUser): Promise<string> =>
    mfaCookieOf(await loginRequest(user).expect(202));

const mfaRequest = (
    method: "get" | "post",
    path: string,
    cookie?: string,
    body: Record<string, unknown> = {}
): supertest.Test => {
    const test: supertest.Test = request(TestData.apiURL)
        [method](path)
        .set("X-Forwarded-For", isolatedClientIp());

    return (cookie ? test.set("Cookie", cookie) : test).send(body);
};

const verifyCode = (cookie: string | undefined, code: string): supertest.Test =>
    mfaRequest("post", "/auth/mfa/verify", cookie, { method: "email", code });

const verifyLink = (cookie: string | undefined, token: string): supertest.Test =>
    mfaRequest("post", "/auth/mfa/verify-link", cookie, { token });

const changeEmailMfa = (
    method: "put" | "delete",
    user: TestUser,
    body: Record<string, unknown>
): supertest.Test =>
    request(TestData.apiURL)
        [method]("/user/mfa/email")
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const setCookieNames = (response: supertest.Response): string[] =>
    []
        .concat(response.headers["set-cookie"] ?? [])
        .map((setCookie: string): string => setCookie.split("=")[0]);

const storedChallenge = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.mfaChallenge").lean()).authentication
        ?.mfaChallenge;

const otherCode = (code: string): string => (code === "000000" ? "000001" : "000000");

const mfaUser = async (prefix: string): Promise<TestUser> => {
    const user: TestUser = await createTestUser(prefix);
    await turnOnEmailMfa(user);
    return user;
};

const expectLoggedIn = async (response: supertest.Response, user: TestUser): Promise<void> => {
    expect(response.body).toEqual({
        message: Responses.Authentication.loginSuccess(user.username)
    });
    expect(setCookieNames(response).sort()).toEqual(
        [mfaCookie, deviceCookie, sessionCookie].sort()
    );
    expect(mfaCookieOf(response)).toBe(`${mfaCookie}=`);

    const sessionCookieValue: string = []
        .concat(response.headers["set-cookie"])
        .find((setCookie: string): boolean => setCookie.startsWith(`${sessionCookie}=`));
    const { body } = await request(TestData.apiURL)
        .get("/user")
        .set("Cookie", sessionCookieValue.split(";")[0])
        .expect(200);
    expect(body).toMatchObject({ _id: user.id, mfa: { email: true } });
    expect(await storedChallenge(user)).toBeUndefined();
};

describe("Logins without MFA", (): void => {
    it("should log in with the same answer and cookies as before", async (): Promise<void> => {
        const user: TestUser = await createTestUser("nomfa");

        const response: supertest.Response = await loginRequest(user).expect(200);

        expect(response.body).toEqual({
            message: Responses.Authentication.loginSuccess(user.username)
        });
        expect(setCookieNames(response)).toEqual([sessionCookie, deviceCookie]);
        expect(await storedChallenge(user)).toBeUndefined();
    });

    it("should show e-mail MFA as off", async (): Promise<void> => {
        const user: TestUser = await createTestUser("nomfa");

        const { body } = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", user.cookie)
            .expect(200);

        expect(body.mfa).toEqual({ email: false, totp: false, passkeys: 0, recoveryCodesLeft: 0 });
    });
});

describe("PUT and DELETE /user/mfa/email", (): void => {
    it("should turn e-mail MFA on and off with the password", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfaon");

        const on: supertest.Response = await changeEmailMfa("put", user, {
            password: user.password
        }).expect(200);
        expect(on.body).toEqual({
            message: Responses.Mfa.emailMfaOn,
            recoveryCodes: expect.any(Array)
        });
        expect((await loginRequest(user).expect(202)).body).toEqual({
            mfaRequired: true,
            methods: ["email", "recovery"]
        });

        const off: supertest.Response = await changeEmailMfa("delete", user, {
            password: user.password
        }).expect(200);
        expect(off.body).toEqual({ message: Responses.Mfa.emailMfaOff });
        await loginRequest(user).expect(200);
    });

    it("should answer 400 without a password and 403 for a wrong one", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfapw");

        for (const method of ["put", "delete"] as const) {
            const missing: supertest.Response = await changeEmailMfa(method, user, {}).expect(400);
            expect(missing.body).toEqual({ error: Responses.Mfa.missingPassword });

            const wrong: supertest.Response = await changeEmailMfa(method, user, {
                password: `${user.password}x`
            }).expect(403);
            expect(wrong.body).toEqual({ error: Responses.Authentication.incorrectPassword });
        }

        await loginRequest(user).expect(200);
    });

    it("should need a confirmed e-mail address to turn it on", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfauv");
        await UserModel.updateOne(
            { _id: user.id },
            { $unset: { "authentication.emailVerifiedAt": 1 } }
        );

        const response: supertest.Response = await changeEmailMfa("put", user, {
            password: user.password
        }).expect(409);

        expect(response.body).toEqual({ error: Responses.Mfa.emailNotVerified });
        await loginRequest(user).expect(200);
    });

    it("should need a recent GitHub confirmation without a password", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfagh");
        await linkGithub(user, true);
        await confirmGithub(user, new Date(Date.now() - (GITHUB_REAUTH_MINUTES + 1) * 60 * 1000));

        const stale: supertest.Response = await changeEmailMfa("put", user, {}).expect(403);
        expect(stale.body).toEqual({
            error: Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
        });

        await confirmGithub(user);
        await changeEmailMfa("put", user, {}).expect(200);

        const { body } = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", user.cookie)
            .expect(200);
        expect(body.mfa).toEqual({ email: true, totp: false, passkeys: 0, recoveryCodesLeft: 10 });
    });

    it("should drop a waiting login when turned off", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfadr");
        const cookie: string = await startMfaLogin(user);

        await changeEmailMfa("delete", user, { password: user.password }).expect(200);

        expect(await storedChallenge(user)).toBeUndefined();
        await mfaRequest("get", "/auth/mfa", cookie).expect(403);
    });
});

describe("Password login with e-mail MFA", (): void => {
    it("should start a challenge instead of a session", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfast");

        const response: supertest.Response = await loginRequest(user).expect(202);

        expect(response.body).toEqual({ mfaRequired: true, methods: ["email"] });
        expect(setCookieNames(response)).toEqual([mfaCookie]);
        const [setCookie] = response.headers["set-cookie"];
        expect(setCookie.split("; ")).toEqual(
            expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
        );
        expect(await storedChallenge(user)).toEqual({
            hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            expiresAt: expect.any(Date),
            attempts: 0
        });

        const methods: supertest.Response = await mfaRequest(
            "get",
            "/auth/mfa",
            mfaCookieOf(response)
        ).expect(200);
        expect(methods.body).toEqual({ methods: ["email"] });

        const sent: supertest.Response = await mfaRequest(
            "post",
            "/auth/mfa/email",
            mfaCookieOf(response)
        ).expect(202);
        expect(sent.body).toEqual({ message: Responses.Mfa.emailCodeSent });
        expect((await storedChallenge(user)).email).toEqual({
            hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            linkHash: expect.stringMatching(/^[0-9a-f]{64}$/)
        });
    });

    it("should keep the earlier code and link when the mail fails", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfamf");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        await UserModel.updateOne(
            { _id: user.id },
            { $set: { "authentication.mfaEmailSentAt": new Date(Date.now() - 61 * 1000) } }
        );
        const stored = async () =>
            (
                await UserModel.findById(user.id)
                    .select(
                        "+authentication.mfaChallenge +authentication.mfaEmailSentAt +authentication.mfaEmailSends"
                    )
                    .lean()
            ).authentication;
        const before = await stored();
        const sendMail: jest.SpyInstance = jest
            .spyOn(mail, "sendMail")
            .mockRejectedValue(new Error("SMTP down"));
        jest.spyOn(console, "error").mockImplementation((): void => undefined);

        try {
            expect(await runSendMfaEmail(cookie)).toBe(503);
        } finally {
            jest.restoreAllMocks();
        }

        expect(sendMail).toHaveBeenCalledTimes(1);
        const after = await stored();
        expect(after.mfaChallenge.email).toEqual(before.mfaChallenge.email);
        expect(after.mfaEmailSentAt).toEqual(before.mfaEmailSentAt);
        expect(before.mfaEmailSends.count).toBe(1);
        expect(after.mfaEmailSends).toEqual(before.mfaEmailSends);
        await verifyCode(cookie, mailed.code).expect(200);
    });

    it("should log in with the mailed code", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfacd");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        expect(mailed.to).toBe(user.email);
        await verifyCode(cookie, otherCode(mailed.code)).expect(400);
        await expectLoggedIn(await verifyCode(cookie, mailed.code).expect(200), user);

        const again: supertest.Response = await verifyCode(cookie, mailed.code).expect(403);
        expect(again.body).toEqual({ error: Responses.Mfa.challengeExpired });
    });

    it("should log in with the mailed link in the same browser", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaln");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        expect(mailed.link).toMatch(
            new RegExp(`^${baseSiteUrl.replace(/[.]/g, "\\.")}/login/mfa#token=[\\w-]{43}$`)
        );
        await expectLoggedIn(await verifyLink(cookie, mailed.token).expect(200), user);
    });

    it("should refuse the link without the browser's MFA cookie", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfanc");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        const response: supertest.Response = await verifyLink(undefined, mailed.token).expect(403);

        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
        expect((await storedChallenge(user)).attempts).toBe(0);
        await verifyLink(cookie, mailed.token).expect(200);
    });

    it("should refuse the code and link of an earlier login", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaol");
        const oldCookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(oldCookie);
        const cookie: string = await startMfaLogin(user);

        await verifyCode(oldCookie, mailed.code).expect(403);
        await verifyCode(cookie, mailed.code).expect(400);
        const link: supertest.Response = await verifyLink(cookie, mailed.token).expect(400);
        expect(link.body).toEqual({ error: Responses.Mfa.invalidLink });
    });

    it(`should end the challenge after ${MFA_CHALLENGE_ATTEMPTS} wrong codes and links`, async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfacp");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        for (let attempt: number = 1; attempt <= MFA_CHALLENGE_ATTEMPTS; attempt++) {
            const wrong: supertest.Response =
                attempt % 2
                    ? await verifyCode(cookie, otherCode(mailed.code)).expect(400)
                    : await verifyLink(cookie, "a".repeat(43)).expect(400);
            expect(wrong.body.error).toBeDefined();
        }

        const response: supertest.Response = await verifyCode(cookie, mailed.code).expect(403);
        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
        expect((await storedChallenge(user)).attempts).toBe(MFA_CHALLENGE_ATTEMPTS);
        await verifyLink(cookie, mailed.token).expect(403);
    });

    it(`should answer 429 over ${CODE_FAILURES_PER_DAY} wrong tries a day`, async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaday");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: {
                    "authentication.mfaFailures": {
                        count: CODE_FAILURES_PER_DAY,
                        since: new Date()
                    }
                }
            }
        );

        const response: supertest.Response = await verifyCode(cookie, mailed.code).expect(429);

        expect(response.body).toEqual({
            error: Responses.tooManyFailedAttempts,
            retryAfter: expect.any(Number)
        });
        expect((await storedChallenge(user)).attempts).toBe(0);
    });

    it("should not count a right code against the day's tries", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaun");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        await verifyCode(cookie, otherCode(mailed.code)).expect(400);
        await verifyCode(cookie, mailed.code).expect(200);

        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.mfaFailures")
            .lean();
        expect(authentication.mfaFailures.count).toBe(1);
    });

    it("should refuse a login suspended between the steps", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfasu");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        await UserModel.updateOne({ _id: user.id }, { $set: { suspendedAt: new Date() } });

        const response: supertest.Response = await verifyCode(cookie, mailed.code).expect(403);

        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
        expect(setCookieNames(response)).toEqual([mfaCookie]);
    });

    it("should refuse a method that isn't on and a missing code without using a try", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfame");
        const cookie: string = await startMfaLogin(user);

        const totp: supertest.Response = await mfaRequest("post", "/auth/mfa/verify", cookie, {
            method: "totp",
            code: "123456"
        }).expect(400);
        expect(totp.body).toEqual({ error: Responses.Mfa.methodNotOn });

        const missing: supertest.Response = await mfaRequest("post", "/auth/mfa/verify", cookie, {
            method: "email"
        }).expect(400);
        expect(missing.body).toEqual({ error: Responses.Mfa.missingProof });

        expect((await storedChallenge(user)).attempts).toBe(0);
    });

    it("should answer 429 to a second code within a minute", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfars");
        const cookie: string = await startMfaLogin(user);
        await mailedMfaEmail(cookie);

        const response: supertest.Response = await mfaRequest(
            "post",
            "/auth/mfa/email",
            await startMfaLogin(user)
        ).expect(429);

        expect(response.body).toMatchObject({ reason: "resendCooldown" });
    });

    it("should answer 403 to MFA requests without a challenge", async (): Promise<void> => {
        for (const [method, path] of [
            ["get", "/auth/mfa"],
            ["post", "/auth/mfa/email"],
            ["post", "/auth/mfa/verify"],
            ["post", "/auth/mfa/verify-link"]
        ] as const) {
            const response: supertest.Response = await mfaRequest(method, path, undefined, {
                method: "email",
                code: "123456",
                token: "x"
            }).expect(403);
            expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
        }
    });

    it("should drop the challenge on logout", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfalo");
        const cookie: string = await startMfaLogin(user);

        await mfaRequest("post", "/auth/logout", cookie).expect(200);

        expect(await storedChallenge(user)).toBeUndefined();
    });

    it("should keep the live session while a challenge waits", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfals");
        const cookie: string = await startMfaLogin(user);

        await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(200);
        await mfaRequest("get", "/auth/mfa", cookie).expect(200);
    });

    it("should drop the challenge on a password change", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfapc");
        const cookie: string = await startMfaLogin(user);
        const newPassword: string = `${user.password}new`;

        await request(TestData.apiURL)
            .patch("/user/password")
            .set("Cookie", user.cookie)
            .send({ currentPassword: user.password, newPassword })
            .expect(200);

        expect(await storedChallenge(user)).toBeUndefined();
        await mfaRequest("get", "/auth/mfa", cookie).expect(403);
        await loginRequest({ ...user, password: newPassword }).expect(202);
    });
});

describe("Ending a waiting MFA challenge", (): void => {
    it("should drop the challenge and its mailed code when the e-mail address changes", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaec");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        const newEmail: string = testEmailOf(`mfaec${randomHex(5)}`);

        await request(TestData.apiURL)
            .patch("/user/email")
            .set("Cookie", user.cookie)
            .send({ email: newEmail, password: user.password })
            .expect(202);
        const code: string = createEmailCode();
        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: {
                    "authentication.emailChange.hash": hashEmailCode(
                        emailChangeScope(user.id, newEmail),
                        code
                    )
                }
            }
        );
        await request(TestData.apiURL)
            .post("/user/email/confirm")
            .set("Cookie", user.cookie)
            .send({ code })
            .expect(200);

        expect(await storedChallenge(user)).toBeUndefined();
        await verifyCode(cookie, mailed.code).expect(403);
        await verifyLink(cookie, mailed.token).expect(403);
    });

    it("should drop the challenge and the day's wrong tries on a password reset", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfapr");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        await verifyCode(cookie, otherCode(mailed.code)).expect(400);
        await runRequestReset(user.email);
        const code: string = createEmailCode();
        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: {
                    "authentication.passwordReset.hash": hashEmailCode(
                        passwordResetScope(user.id, user.email),
                        code
                    )
                }
            }
        );

        await request(TestData.apiURL)
            .post("/auth/password-reset/confirm")
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email: user.email, code, newPassword: `${user.password}new` })
            .expect(200);

        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.mfaChallenge +authentication.mfaFailures")
            .lean();
        expect(authentication.mfaChallenge).toBeUndefined();
        expect(authentication.mfaFailures).toBeUndefined();
        await verifyCode(cookie, mailed.code).expect(403);
    });

    it("should drop the challenge when a GitHub account sets a password", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfasp");
        await linkGithub(user, true);
        await confirmGithub(user);
        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: {
                    "authentication.mfaChallenge": {
                        hash: randomHex(32),
                        expiresAt: new Date(Date.now() + 60 * 1000),
                        attempts: 0
                    }
                }
            }
        );

        await request(TestData.apiURL)
            .post("/user/password")
            .set("Cookie", user.cookie)
            .send({ password: randomHex(12) })
            .expect(200);

        expect(await storedChallenge(user)).toBeUndefined();
    });

    it("should refuse a login the superuser suspends between the steps", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaas");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        await request(TestData.apiURL)
            .patch(`/admin/users/${user.id}/suspension`)
            .set("Cookie", TestData.superuser.cookie)
            .send({ suspended: true })
            .expect(200);

        const response: supertest.Response = await verifyCode(cookie, mailed.code).expect(403);
        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
        expect(await storedChallenge(user)).toBeUndefined();
    });

    it("should refuse a login the superuser logs out between the steps", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaal");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        await request(TestData.apiURL)
            .post(`/admin/users/${user.id}/logout`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);

        await verifyCode(cookie, mailed.code).expect(403);
        await verifyLink(cookie, mailed.token).expect(403);
    });

    it("should refuse an expired challenge", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaex");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        await UserModel.updateOne(
            { _id: user.id },
            { $set: { "authentication.mfaChallenge.expiresAt": new Date(Date.now() - 1000) } }
        );

        await mfaRequest("get", "/auth/mfa", cookie).expect(403);
        const response: supertest.Response = await verifyCode(cookie, mailed.code).expect(403);
        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
    });
});

describe("MFA challenge cookies and races", (): void => {
    it("should refuse a forged cookie without using a try", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfafg");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);
        const forged: string = `${mfaCookie}=${user.id}.${createOauthSecret()}`;

        await verifyCode(forged, mailed.code).expect(403);
        await verifyLink(forged, mailed.token).expect(403);

        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.mfaChallenge +authentication.mfaFailures")
            .lean();
        expect(authentication.mfaChallenge.attempts).toBe(0);
        expect(authentication.mfaFailures).toBeUndefined();
        await verifyCode(cookie, mailed.code).expect(200);
    });

    it("should start exactly one session from parallel right codes", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfapa");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        const responses: supertest.Response[] = await Promise.all(
            Array.from({ length: 12 }, () => verifyCode(cookie, mailed.code))
        );

        const started: supertest.Response[] = responses.filter(({ status }) => status === 200);
        expect(started).toHaveLength(1);
        expect(
            responses.filter(({ status }) => status !== 200).map(({ status }) => status)
        ).toEqual(Array(11).fill(403));
        const sessionSetCookie: string = []
            .concat(started[0].headers["set-cookie"])
            .find((setCookie: string): boolean => setCookie.startsWith(`${sessionCookie}=`));
        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.sessionToken")
            .lean();
        expect(authentication.sessionToken).toBe(
            hashSessionToken(decodeURIComponent(sessionSetCookie.split(";")[0].split("=")[1]))
        );
    });

    it("should remember the device after a password login's second step", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfadv");
        const cookie: string = await startMfaLogin(user);
        const mailed = await mailedMfaEmail(cookie);

        const response: supertest.Response = await verifyCode(cookie, mailed.code).expect(200);

        const device: string = []
            .concat(response.headers["set-cookie"])
            .find((setCookie: string): boolean => setCookie.startsWith(`${deviceCookie}=`));
        expect(device.split("; ")).toEqual(
            expect.arrayContaining(["Path=/auth/login", "HttpOnly"])
        );
    });

    it(`should answer 429 over ${MFA_EMAILS_PER_DAY} MFA mails a day`, async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfaml");
        const cookie: string = await startMfaLogin(user);
        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: {
                    "authentication.mfaEmailSends": { count: MFA_EMAILS_PER_DAY, since: new Date() }
                }
            }
        );

        const response: supertest.Response = await mfaRequest(
            "post",
            "/auth/mfa/email",
            cookie
        ).expect(429);

        expect(response.body).toEqual({
            error: Responses.Mfa.tooManyEmails,
            retryAfter: expect.any(Number),
            reason: "mfaEmailLimit"
        });
        expect((await storedChallenge(user)).email).toBeUndefined();
    });
});
