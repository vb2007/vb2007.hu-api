import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    CODE_FAILURES_PER_DAY,
    GITHUB_REAUTH_MINUTES,
    MFA_CHALLENGE_ATTEMPTS,
    MFA_TOTP_SETUP_ATTEMPTS
} from "../constants/limits";
import { UserModel } from "../database/users";
import { deviceCookie } from "../helpers/deviceCookie";
import { mfaCookie } from "../helpers/mfa";
import { decryptTotpSecret, fromBase32, toBase32, totpCode, totpStepAt } from "../helpers/mfaTotp";
import { sessionCookie } from "../helpers/session";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    isolatedClientIp,
    linkGithub
} from "./helpers/testUsers";
import { mfaCookieOf, turnOnEmailMfa } from "./helpers/mfa";

const loginRequest = (user: TestUser): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email: user.email, password: user.password });

const startMfaLogin = async (user: TestUser): Promise<string> =>
    mfaCookieOf(await loginRequest(user).expect(202));

const verifyTotp = (cookie: string, code: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/mfa/verify")
        .set("Cookie", cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ method: "totp", code });

const totpRequest = (
    method: "post" | "delete",
    path: string,
    user: TestUser,
    body: Record<string, unknown>
): supertest.Test =>
    request(TestData.apiURL)
        [method](path)
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const codeAt = (secret: string, stepsFromNow: number): string =>
    totpCode(fromBase32(secret), totpStepAt(Date.now()) + stepsFromNow);

const wrongCode = (secret: string): string => {
    const near: string[] = [-2, -1, 0, 1, 2].map((steps: number): string => codeAt(secret, steps));

    return ["000000", "000001", "000002", "000003", "000004", "000005"].find(
        (code: string): boolean => !near.includes(code)
    );
};

const setUpTotp = async (user: TestUser, body: Record<string, unknown> = {}): Promise<string> =>
    (
        await totpRequest("post", "/user/mfa/totp", user, {
            password: user.password,
            ...body
        }).expect(200)
    ).body.secret;

const confirmTotp = (user: TestUser, code: string) =>
    totpRequest("post", "/user/mfa/totp/confirm", user, { code });

const turnOnTotp = async (user: TestUser): Promise<string> => {
    const secret: string = await setUpTotp(user);
    await confirmTotp(user, codeAt(secret, 0)).expect(200);
    return secret;
};

const storedTotp = async (user: TestUser) =>
    (
        await UserModel.findById(user.id)
            .select(
                "+authentication.mfaTotpSecret +authentication.mfaTotpLastStep +authentication.mfaTotpSetup +authentication.mfaChallenge"
            )
            .lean()
    ).authentication;

const mfaStatusOf = async (cookie: string) =>
    (await request(TestData.apiURL).get("/user").set("Cookie", cookie).expect(200)).body.mfa;

const setCookieNames = (response: supertest.Response): string[] =>
    []
        .concat(response.headers["set-cookie"] ?? [])
        .map((setCookie: string): string => setCookie.split("=")[0]);

const sessionCookieOf = (response: supertest.Response): string =>
    []
        .concat(response.headers["set-cookie"])
        .find((setCookie: string): boolean => setCookie.startsWith(`${sessionCookie}=`))
        .split(";")[0];

describe("TOTP codes", (): void => {
    it("should match the RFC 6238 SHA1 test vector", (): void => {
        const seed: Buffer = Buffer.from("12345678901234567890");

        expect(totpCode(seed, totpStepAt(59 * 1000))).toBe("287082");
        expect(totpCode(seed, totpStepAt(1111111109 * 1000))).toBe("081804");
    });

    it("should encode and decode base32", (): void => {
        const seed: Buffer = Buffer.from("12345678901234567890");

        expect(toBase32(seed)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        expect(fromBase32(toBase32(seed))).toEqual(seed);
    });
});

describe("Logins without TOTP", (): void => {
    it("should log in as before, also with an unconfirmed setup", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpnone");
        await setUpTotp(user);

        const response: supertest.Response = await loginRequest(user).expect(200);

        expect(response.body).toEqual({
            message: Responses.Authentication.loginSuccess(user.username)
        });
        expect(setCookieNames(response)).toEqual([sessionCookie, deviceCookie]);
        expect(await mfaStatusOf(sessionCookieOf(response))).toMatchObject({
            email: false,
            totp: false
        });
    });
});

describe("POST /user/mfa/totp and /user/mfa/totp/confirm", (): void => {
    it("should set up TOTP, turn it on with a code and log in with it", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpon");

        const setup: supertest.Response = await totpRequest("post", "/user/mfa/totp", user, {
            password: user.password
        }).expect(200);
        const { secret } = setup.body;
        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(setup.body).toEqual({
            secret,
            otpauthUrl: `otpauth://totp/vb2007.hu:${encodeURIComponent(user.username)}?secret=${secret}&issuer=vb2007.hu&algorithm=SHA1&digits=6&period=30`
        });

        const on: supertest.Response = await confirmTotp(user, codeAt(secret, 0)).expect(200);
        expect(on.body).toEqual({ message: Responses.Mfa.totpMfaOn });
        expect(await mfaStatusOf(user.cookie)).toMatchObject({ email: false, totp: true });

        const login: supertest.Response = await loginRequest(user).expect(202);
        expect(login.body).toEqual({ mfaRequired: true, methods: ["totp"] });

        const verified: supertest.Response = await verifyTotp(
            mfaCookieOf(login),
            codeAt(secret, 1)
        ).expect(200);
        expect(verified.body).toEqual({
            message: Responses.Authentication.loginSuccess(user.username)
        });
        expect(setCookieNames(verified).sort()).toEqual(
            [mfaCookie, deviceCookie, sessionCookie].sort()
        );
        expect(await mfaStatusOf(sessionCookieOf(verified))).toMatchObject({
            email: false,
            totp: true
        });
        expect((await storedTotp(user)).mfaChallenge).toBeUndefined();
    });

    it("should list TOTP after e-mail when both are on", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpboth");
        await turnOnEmailMfa(user);
        await turnOnTotp(user);

        expect((await loginRequest(user).expect(202)).body.methods).toEqual(["email", "totp"]);
    });

    it(`should refuse wrong confirm codes and end the setup after ${MFA_TOTP_SETUP_ATTEMPTS}`, async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpconf");

        const none: supertest.Response = await confirmTotp(user, "123456").expect(400);
        expect(none.body).toEqual({ error: Responses.EmailCodes.invalidCode });

        const secret: string = await setUpTotp(user);
        const missing: supertest.Response = await confirmTotp(user, "").expect(400);
        expect(missing.body).toEqual({ error: Responses.Users.missingCode });

        for (let attempt: number = 1; attempt <= MFA_TOTP_SETUP_ATTEMPTS; attempt++) {
            const wrong: supertest.Response = await confirmTotp(user, wrongCode(secret)).expect(
                400
            );
            expect(wrong.body).toEqual({ error: Responses.EmailCodes.invalidCode });
        }

        await confirmTotp(user, codeAt(secret, 0)).expect(400);
        expect(await mfaStatusOf(user.cookie)).toMatchObject({ email: false, totp: false });

        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.mfaFailures")
            .lean();
        expect(authentication.mfaFailures.count).toBe(MFA_TOTP_SETUP_ATTEMPTS + 2);

        const again: string = await setUpTotp(user);
        await confirmTotp(user, codeAt(again, 0)).expect(200);
    });

    it("should refuse an expired setup", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpexp");
        const secret: string = await setUpTotp(user);
        await UserModel.updateOne(
            { _id: user.id },
            { $set: { "authentication.mfaTotpSetup.expiresAt": new Date(Date.now() - 1000) } }
        );

        await confirmTotp(user, codeAt(secret, 0)).expect(400);
        expect(await mfaStatusOf(user.cookie)).toMatchObject({ email: false, totp: false });
    });

    it("should keep a working secret until a new setup is confirmed", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpnew");
        const first: string = await turnOnTotp(user);
        const working: string = (await storedTotp(user)).mfaTotpSecret;
        const second: string = await setUpTotp(user);

        expect((await storedTotp(user)).mfaTotpSecret).toBe(working);
        expect(await mfaStatusOf(user.cookie)).toMatchObject({ totp: true });

        await confirmTotp(user, codeAt(second, 0)).expect(200);
        const cookie: string = await startMfaLogin(user);
        await verifyTotp(cookie, codeAt(first, 1)).expect(400);
        await verifyTotp(cookie, codeAt(second, 1)).expect(200);
    });

    it("should refuse a confirm from another session than the setup's", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpses");
        const secret: string = await setUpTotp(user);
        const other: TestUser = {
            ...user,
            cookie: sessionCookieOf(await loginRequest(user).expect(200))
        };

        const response: supertest.Response = await confirmTotp(other, codeAt(secret, 0)).expect(
            400
        );
        expect(response.body).toEqual({ error: Responses.EmailCodes.invalidCode });
        expect(await mfaStatusOf(other.cookie)).toMatchObject({ totp: false });
    });
});

describe("TOTP management reauth", (): void => {
    it("should answer 400 without a password and 403 for a wrong one", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tppw");
        const secret: string = await setUpTotp(user);

        const requests: [string, "post" | "delete", Record<string, unknown>][] = [
            ["/user/mfa/totp", "post", {}],
            ["/user/mfa/totp", "delete", {}]
        ];

        for (const [path, method, body] of requests) {
            const missing: supertest.Response = await totpRequest(method, path, user, body).expect(
                400
            );
            expect(missing.body).toEqual({ error: Responses.Mfa.missingPassword });

            const wrong: supertest.Response = await totpRequest(method, path, user, {
                ...body,
                password: `${user.password}x`
            }).expect(403);
            expect(wrong.body).toEqual({ error: Responses.Authentication.incorrectPassword });
        }

        expect((await storedTotp(user)).mfaTotpSetup.attempts).toBe(0);
        await confirmTotp(user, codeAt(secret, 0)).expect(200);
    });

    it("should need a recent GitHub confirmation without a password", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpgh");
        await linkGithub(user, true);
        await confirmGithub(user, new Date(Date.now() - (GITHUB_REAUTH_MINUTES + 1) * 60 * 1000));

        const stale: supertest.Response = await totpRequest(
            "post",
            "/user/mfa/totp",
            user,
            {}
        ).expect(403);
        expect(stale.body).toEqual({
            error: Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
        });

        await confirmGithub(user);
        const { secret } = (await totpRequest("post", "/user/mfa/totp", user, {}).expect(200)).body;
        await confirmGithub(user, new Date(Date.now() - (GITHUB_REAUTH_MINUTES + 1) * 60 * 1000));
        await confirmTotp(user, codeAt(secret, 0)).expect(200);
        await confirmGithub(user);
        expect(await mfaStatusOf(user.cookie)).toMatchObject({ email: false, totp: true });

        await totpRequest("delete", "/user/mfa/totp", user, {}).expect(200);
        expect(await mfaStatusOf(user.cookie)).toMatchObject({ email: false, totp: false });
    });

    it("should need a login", async (): Promise<void> => {
        await request(TestData.apiURL).post("/user/mfa/totp").send({}).expect(403);
        await request(TestData.apiURL).post("/user/mfa/totp/confirm").send({}).expect(403);
        await request(TestData.apiURL).delete("/user/mfa/totp").send({}).expect(403);
    });
});

describe("Login with TOTP", (): void => {
    it("should refuse a replayed code and an older one", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tprep");
        const secret: string = await turnOnTotp(user);
        const code: string = codeAt(secret, 1);

        await verifyTotp(await startMfaLogin(user), code).expect(200);

        const cookie: string = await startMfaLogin(user);
        const replayed: supertest.Response = await verifyTotp(cookie, code).expect(400);
        expect(replayed.body).toEqual({ error: Responses.EmailCodes.invalidCode });
        await verifyTotp(cookie, codeAt(secret, -1)).expect(400);
        expect((await storedTotp(user)).mfaChallenge.attempts).toBe(2);
    });

    it("should refuse the code that confirmed the setup", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpcfrp");
        const secret: string = await setUpTotp(user);
        const code: string = codeAt(secret, 0);
        await confirmTotp(user, code).expect(200);

        await verifyTotp(await startMfaLogin(user), code).expect(400);
    });

    it(`should end the challenge after ${MFA_CHALLENGE_ATTEMPTS} wrong codes`, async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpwrng");
        const secret: string = await turnOnTotp(user);
        const cookie: string = await startMfaLogin(user);

        for (let attempt: number = 1; attempt <= MFA_CHALLENGE_ATTEMPTS; attempt++) {
            await verifyTotp(cookie, wrongCode(secret)).expect(400);
        }

        const response: supertest.Response = await verifyTotp(cookie, codeAt(secret, 1)).expect(
            403
        );
        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
        expect((await storedTotp(user)).mfaChallenge).toBeUndefined();
    });

    it(`should answer 429 over ${CODE_FAILURES_PER_DAY} wrong tries a day`, async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpday");
        const secret: string = await turnOnTotp(user);
        const cookie: string = await startMfaLogin(user);
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

        const response: supertest.Response = await verifyTotp(cookie, codeAt(secret, 1)).expect(
            429
        );
        expect(response.body).toEqual({
            error: Responses.tooManyFailedAttempts,
            retryAfter: expect.any(Number)
        });

        const setup: supertest.Response = await confirmTotp(user, "123456").expect(429);
        expect(setup.body.error).toBe(Responses.tooManyFailedAttempts);
    });
});

describe("DELETE /user/mfa/totp", (): void => {
    it("should turn TOTP off and drop a waiting login", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpoff");
        await turnOnTotp(user);
        await setUpTotp(user);
        const cookie: string = await startMfaLogin(user);

        const off: supertest.Response = await totpRequest("delete", "/user/mfa/totp", user, {
            password: user.password
        }).expect(200);

        expect(off.body).toEqual({ message: Responses.Mfa.totpMfaOff });
        const stored = await storedTotp(user);
        expect(stored.mfaTotpSecret).toBeUndefined();
        expect(stored.mfaTotpLastStep).toBeUndefined();
        expect(stored.mfaTotpSetup).toBeUndefined();
        expect(stored.mfaChallenge).toBeUndefined();
        await request(TestData.apiURL).get("/auth/mfa").set("Cookie", cookie).expect(403);
        await totpRequest("delete", "/user/mfa/totp", user, { password: user.password }).expect(
            200
        );
        await loginRequest(user).expect(200);
    });

    it("should be cleared fully by the superuser's MFA reset", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tprst");
        await turnOnTotp(user);
        await setUpTotp(user);
        const before = await storedTotp(user);
        expect(before.mfaTotpSecret).toBeDefined();
        expect(before.mfaTotpLastStep).toBeDefined();
        expect(before.mfaTotpSetup).toBeDefined();

        await request(TestData.apiURL)
            .delete(`/admin/users/${user.id}/mfa`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);

        const stored = await storedTotp(user);
        expect(stored.mfaTotpSecret).toBeUndefined();
        expect(stored.mfaTotpLastStep).toBeUndefined();
        expect(stored.mfaTotpSetup).toBeUndefined();
        await loginRequest(user).expect(200);
    });
});

describe("TOTP secret storage", (): void => {
    it("should store the secret only encrypted and never return it", async (): Promise<void> => {
        const user: TestUser = await createTestUser("tpenc");
        const secret: string = await setUpTotp(user);
        const raw: Buffer = fromBase32(secret);
        const plainForms: string[] = [
            secret,
            raw.toString("hex"),
            raw.toString("base64"),
            raw.toString("base64url"),
            raw.toString("latin1")
        ];

        const pending: string = (await storedTotp(user)).mfaTotpSetup.secret;
        await confirmTotp(user, codeAt(secret, 0)).expect(200);
        const stored: string = (await storedTotp(user)).mfaTotpSecret;

        expect(stored).toBe(pending);
        expect(stored).toMatch(/^[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
        for (const plain of plainForms) {
            expect(stored).not.toContain(plain);
        }
        expect(decryptTotpSecret(user.id, stored)).toBe(secret);
        expect(decryptTotpSecret(TestData.superuser.id, stored)).toBeNull();

        const own: supertest.Response = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", user.cookie)
            .expect(200);
        const admin: supertest.Response = await request(TestData.apiURL)
            .get(`/admin/users/${user.id}`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);
        expect(admin.body.user.mfa).toMatchObject({ email: false, totp: true });
        for (const response of [own, admin]) {
            expect(response.text).not.toContain(stored);
            expect(response.text).not.toContain(secret);
        }
    });
});
