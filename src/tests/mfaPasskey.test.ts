import express from "express";
import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { verifyMfa } from "../controllers/mfa";
import * as userDatabase from "../database/users";
import { UserModel } from "../database/users";
import { mfaCookie } from "../helpers/mfa";
import { passkeyLoginCookie } from "../helpers/passkeys";
import { sessionCookie } from "../helpers/session";
import { SoftwareAuthenticator, registerPasskey, userPresent } from "./helpers/passkeys";
import { TestUser, createTestUser, isolatedClientIp } from "./helpers/testUsers";
import { mfaCookieOf, turnOnEmailMfa } from "./helpers/mfa";

const cookieOf = (response: supertest.Response, name: string): string | undefined =>
    []
        .concat(response.headers["set-cookie"] ?? [])
        .find((setCookie: string): boolean => setCookie.startsWith(`${name}=`))
        ?.split(";")[0];

const post = (path: string, cookie?: string, body: Record<string, unknown> = {}) => {
    const test: supertest.Test = request(TestData.apiURL)
        .post(path)
        .set("X-Forwarded-For", isolatedClientIp());

    return (cookie ? test.set("Cookie", cookie) : test).send(body);
};

const sessionOf = (user: TestUser): string => user.cookie.split(";")[0];

const mfaPasskeyUser = async (): Promise<{
    user: TestUser;
    authenticator: SoftwareAuthenticator;
}> => {
    const user: TestUser = await createTestUser("mfapk");
    const authenticator: SoftwareAuthenticator = await registerPasskey(user);
    await turnOnEmailMfa(user);
    return { user, authenticator };
};

const passwordLogin = (user: TestUser): supertest.Test =>
    post("/auth/login", undefined, { email: user.email, password: user.password });

const startLogin = async (
    user: TestUser,
    methods: string[] = ["email", "passkey"]
): Promise<string> => {
    const response: supertest.Response = await passwordLogin(user).expect(202);

    expect(response.body).toEqual({ mfaRequired: true, methods });
    return mfaCookieOf(response);
};

const expectPlainLogin = async (user: TestUser): Promise<void> => {
    const response: supertest.Response = await passwordLogin(user).expect(200);

    expect(response.body).toEqual({
        message: Responses.Authentication.loginSuccess(user.username)
    });
    expect(cookieOf(response, sessionCookie)).toBeDefined();
};

const passkeyOptions = async (cookie: string) =>
    (await post("/auth/mfa/passkey/options", cookie).expect(200)).body;

const verifyPasskey = (cookie: string, response: unknown): supertest.Test =>
    post("/auth/mfa/verify", cookie, { method: "passkey", response });

const storedAuthentication = async (user: TestUser) =>
    (
        await UserModel.findById(user.id)
            .select(
                "+authentication.mfaChallenge +authentication.mfaFailures +authentication.passkeys"
            )
            .lean()
    ).authentication;

const expectRefused = (response: supertest.Response): void => {
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: Responses.Passkeys.invalidPasskey });
};

describe("Passkeys as an MFA method", (): void => {
    it("should log in with e-mail MFA on and a passkey", async (): Promise<void> => {
        const { user, authenticator } = await mfaPasskeyUser();
        const cookie: string = await startLogin(user);

        const replaced = await passkeyOptions(cookie);
        const options = await passkeyOptions(cookie);
        expect(options.challenge).not.toBe(replaced.challenge);
        expect(options).toMatchObject({
            userVerification: "required",
            allowCredentials: [{ id: authenticator.credentialId, type: "public-key" }]
        });

        const response: supertest.Response = await verifyPasskey(
            cookie,
            authenticator.authenticate(options)
        ).expect(200);

        expect(response.body).toEqual({
            message: Responses.Authentication.loginSuccess(user.username)
        });
        expect(cookieOf(response, sessionCookie)).toBeDefined();
        const stored = await storedAuthentication(user);
        expect(stored.mfaChallenge).toBeUndefined();
        expect(stored.passkeys[0]).toMatchObject({
            counter: authenticator.counter,
            lastUsedAt: expect.any(Date)
        });
    });

    it("should not challenge a password login of an account with only a passkey", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfapk");
        await registerPasskey(user);

        await expectPlainLogin(user);
        expect((await storedAuthentication(user)).mfaChallenge).toBeUndefined();
    });

    it("should stop challenging once e-mail MFA is turned off", async (): Promise<void> => {
        const { user } = await mfaPasskeyUser();
        await startLogin(user);

        await request(TestData.apiURL)
            .delete("/user/mfa/email")
            .set("Cookie", sessionOf(user))
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ password: user.password })
            .expect(200);

        await expectPlainLogin(user);
        expect((await storedAuthentication(user)).passkeys).toHaveLength(1);
    });

    it("should log in without a challenge after an admin MFA reset", async (): Promise<void> => {
        const { user } = await mfaPasskeyUser();
        await startLogin(user);

        await request(TestData.apiURL)
            .delete(`/admin/users/${user.id}/mfa`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);

        await expectPlainLogin(user);
        expect((await storedAuthentication(user)).passkeys).toHaveLength(1);
    });

    it("should skip MFA on a passwordless passkey login", async (): Promise<void> => {
        const { authenticator } = await mfaPasskeyUser();

        const options: supertest.Response = await post("/auth/passkey/options").expect(200);
        const response: supertest.Response = await post(
            "/auth/passkey",
            cookieOf(options, passkeyLoginCookie),
            { response: authenticator.authenticate(options.body) }
        ).expect(200);

        expect(cookieOf(response, sessionCookie)).toBeDefined();
    });

    it("should refuse another account's passkey and count the try", async (): Promise<void> => {
        const [{ user, authenticator }, other] = await Promise.all([
            mfaPasskeyUser(),
            mfaPasskeyUser()
        ]);
        const cookie: string = await startLogin(user);

        expectRefused(
            await verifyPasskey(
                cookie,
                other.authenticator.authenticate(await passkeyOptions(cookie))
            )
        );
        const stored = await storedAuthentication(user);
        expect(stored.mfaChallenge.attempts).toBe(1);
        expect(stored.mfaFailures.count).toBe(1);

        await verifyPasskey(
            cookie,
            authenticator.authenticate(await passkeyOptions(cookie))
        ).expect(200);
    });

    it("should use a WebAuthn challenge only once", async (): Promise<void> => {
        const { user, authenticator } = await mfaPasskeyUser();
        const cookie: string = await startLogin(user);
        const options = await passkeyOptions(cookie);

        expectRefused(
            await verifyPasskey(cookie, authenticator.authenticate(options, { flags: userPresent }))
        );
        expectRefused(await verifyPasskey(cookie, authenticator.authenticate(options)));
        expect((await storedAuthentication(user)).mfaChallenge.attempts).toBe(2);

        const next = await passkeyOptions(cookie);
        const assertion = authenticator.authenticate(next);
        await verifyPasskey(cookie, assertion).expect(200);

        const again: string = await startLogin(user);
        expectRefused(await verifyPasskey(again, assertion));
    });

    it("should start one session from the same assertion sent twice at once", async (): Promise<void> => {
        const { user, authenticator } = await mfaPasskeyUser();
        const cookie: string = await startLogin(user);
        const assertion = authenticator.authenticate(await passkeyOptions(cookie));

        const statuses: number[] = (
            await Promise.all([verifyPasskey(cookie, assertion), verifyPasskey(cookie, assertion)])
        )
            .map(({ status }: supertest.Response): number => status)
            .sort();

        expect(statuses[0]).toBe(200);
        expect([400, 403]).toContain(statuses[1]);
    });

    it("should answer 403 without counting a failure when a new login replaces the challenge meanwhile", async (): Promise<void> => {
        const { user, authenticator } = await mfaPasskeyUser();
        const cookie: string = await startLogin(user);
        const assertion = authenticator.authenticate(await passkeyOptions(cookie));
        const usePasskey = userDatabase.usePasskey;
        jest.spyOn(userDatabase, "usePasskey").mockImplementation(
            (...args) =>
                startLogin(user).then(() => usePasskey(...args)) as unknown as ReturnType<
                    typeof usePasskey
                >
        );
        const answer: { status?: number; body?: unknown } = {};
        const res = {
            locals: {},
            status: (status: number) => Object.assign(answer, { status }) && res,
            json: (body: unknown) => Object.assign(answer, { body }) && res,
            cookie: () => res,
            clearCookie: () => res
        };

        try {
            await verifyMfa(
                {
                    cookies: { [mfaCookie]: cookie.split("=")[1] },
                    body: { method: "passkey", response: assertion }
                } as express.Request,
                res as unknown as express.Response,
                jest.fn()
            );
        } finally {
            jest.restoreAllMocks();
        }

        expect(answer).toEqual({ status: 403, body: { error: Responses.Mfa.challengeExpired } });
        expect((await storedAuthentication(user)).mfaFailures.count).toBe(0);
    });

    it("should refuse a wrong assertion and an earlier login's challenge", async (): Promise<void> => {
        const { user, authenticator } = await mfaPasskeyUser();
        const first: string = await startLogin(user);
        const options = await passkeyOptions(first);

        expectRefused(
            await verifyPasskey(first, authenticator.authenticate(options, { rpId: "example.com" }))
        );
        expect((await storedAuthentication(user)).mfaChallenge.attempts).toBe(1);

        const second: string = await startLogin(user);
        expectRefused(await verifyPasskey(second, authenticator.authenticate(options)));
    });

    it("should answer 403 to options without a live challenge", async (): Promise<void> => {
        const response: supertest.Response = await post("/auth/mfa/passkey/options").expect(403);

        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
    });

    it("should answer 400 to a missing response or an account without passkeys", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfapk");
        await turnOnEmailMfa(user);
        const cookie: string = await startLogin(user, ["email"]);

        await post("/auth/mfa/passkey/options", cookie).expect(400);
        const missing: supertest.Response = await verifyPasskey(cookie, "x").expect(400);
        expect(missing.body).toEqual({ error: Responses.Mfa.methodNotOn });

        const withPasskey = await mfaPasskeyUser();
        const passkeyCookie: string = await startLogin(withPasskey.user);
        const notObject: supertest.Response = await verifyPasskey(passkeyCookie, "x").expect(400);
        expect(notObject.body).toEqual({ error: Responses.Mfa.missingProof });
        expect((await storedAuthentication(withPasskey.user)).mfaChallenge.attempts).toBe(0);
    });
});
