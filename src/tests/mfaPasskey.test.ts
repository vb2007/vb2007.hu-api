import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { passkeyLoginCookie, passkeyRegistrationCookie } from "../helpers/passkeys";
import { sessionCookie } from "../helpers/session";
import { SoftwareAuthenticator, userPresent } from "./helpers/passkeys";
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

const addPasskey = async (user: TestUser): Promise<SoftwareAuthenticator> => {
    const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
    const session: string = user.cookie.split(";")[0];
    const options: supertest.Response = await post("/user/passkeys/options", session, {
        password: user.password
    }).expect(200);

    await post("/user/passkeys", `${session}; ${cookieOf(options, passkeyRegistrationCookie)}`, {
        name: "Laptop",
        response: authenticator.register(options.body)
    }).expect(201);

    return authenticator;
};

const startLogin = async (user: TestUser, methods: string[]): Promise<string> => {
    const response: supertest.Response = await post("/auth/login", undefined, {
        email: user.email,
        password: user.password
    }).expect(202);

    expect(response.body).toEqual({ mfaRequired: true, methods });
    return mfaCookieOf(response);
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
        const user: TestUser = await createTestUser("mfapk");
        const authenticator: SoftwareAuthenticator = await addPasskey(user);
        await turnOnEmailMfa(user);
        const cookie: string = await startLogin(user, ["email", "passkey"]);

        const options = await passkeyOptions(cookie);
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

    it("should challenge a password login of an account with only a passkey", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfapk");
        const authenticator: SoftwareAuthenticator = await addPasskey(user);
        const cookie: string = await startLogin(user, ["passkey"]);

        await post("/auth/mfa/email", cookie).expect(400);
        await verifyPasskey(
            cookie,
            authenticator.authenticate(await passkeyOptions(cookie))
        ).expect(200);
    });

    it("should skip MFA on a passwordless passkey login", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfapk");
        const authenticator: SoftwareAuthenticator = await addPasskey(user);
        await turnOnEmailMfa(user);

        const options: supertest.Response = await post("/auth/passkey/options").expect(200);
        const response: supertest.Response = await post(
            "/auth/passkey",
            cookieOf(options, passkeyLoginCookie),
            { response: authenticator.authenticate(options.body) }
        ).expect(200);

        expect(cookieOf(response, sessionCookie)).toBeDefined();
    });

    it("should refuse another account's passkey and count the try", async (): Promise<void> => {
        const [user, other] = await Promise.all([createTestUser("mfapk"), createTestUser("mfapk")]);
        const [authenticator, otherAuthenticator] = await Promise.all([
            addPasskey(user),
            addPasskey(other)
        ]);
        const cookie: string = await startLogin(user, ["passkey"]);

        expectRefused(
            await verifyPasskey(
                cookie,
                otherAuthenticator.authenticate(await passkeyOptions(cookie))
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
        const user: TestUser = await createTestUser("mfapk");
        const authenticator: SoftwareAuthenticator = await addPasskey(user);
        const cookie: string = await startLogin(user, ["passkey"]);
        const options = await passkeyOptions(cookie);

        expectRefused(
            await verifyPasskey(cookie, authenticator.authenticate(options, { flags: userPresent }))
        );
        expectRefused(await verifyPasskey(cookie, authenticator.authenticate(options)));
        expect((await storedAuthentication(user)).mfaChallenge.attempts).toBe(2);

        const next = await passkeyOptions(cookie);
        const assertion = authenticator.authenticate(next);
        await verifyPasskey(cookie, assertion).expect(200);

        const again: string = await startLogin(user, ["passkey"]);
        expectRefused(await verifyPasskey(again, assertion));
    });

    it("should refuse a wrong assertion and an earlier login's challenge", async (): Promise<void> => {
        const user: TestUser = await createTestUser("mfapk");
        const authenticator: SoftwareAuthenticator = await addPasskey(user);
        const first: string = await startLogin(user, ["passkey"]);
        const options = await passkeyOptions(first);

        expectRefused(
            await verifyPasskey(first, authenticator.authenticate(options, { rpId: "example.com" }))
        );
        expect((await storedAuthentication(user)).mfaChallenge.attempts).toBe(1);

        const second: string = await startLogin(user, ["passkey"]);
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

        const withPasskey: TestUser = await createTestUser("mfapk");
        await addPasskey(withPasskey);
        const passkeyCookie: string = await startLogin(withPasskey, ["passkey"]);
        const notObject: supertest.Response = await verifyPasskey(passkeyCookie, "x").expect(400);
        expect(notObject.body).toEqual({ error: Responses.Mfa.missingProof });
        expect((await storedAuthentication(withPasskey)).mfaChallenge.attempts).toBe(0);
    });
});
