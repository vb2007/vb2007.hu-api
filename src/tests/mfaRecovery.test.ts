import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { GITHUB_REAUTH_MINUTES, MFA_RECOVERY_CODES } from "../constants/limits";
import { UserModel, passwordResetScope } from "../database/users";
import { createEmailCode, hashEmailCode } from "../helpers/emailCodes";
import { sessionCookie } from "../helpers/session";
import { hashSessionToken } from "../helpers";
import { TestUser, createTestUser, isolatedClientIp, linkGithub } from "./helpers/testUsers";
import { mfaCookieOf, turnOnEmailMfa as turnOnEmailMfaInDb } from "./helpers/mfa";
import { runRequestReset } from "./helpers/passwordReset";

const recoveryCodePattern: RegExp = /^[a-z2-7]{5}-[a-z2-7]{5}$/;

const userRequest = (
    method: "put" | "delete" | "post",
    path: string,
    user: TestUser,
    body: Record<string, unknown>
): supertest.Test =>
    request(TestData.apiURL)
        [method](path)
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const turnOnEmailMfa = (user: TestUser): supertest.Test =>
    userRequest("put", "/user/mfa/email", user, { password: user.password });

const replaceCodes = (user: TestUser, body: Record<string, unknown>): supertest.Test =>
    userRequest("post", "/user/mfa/recovery-codes", user, body);

const loginRequest = (user: TestUser): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email: user.email, password: user.password });

const startMfaLogin = async (user: TestUser): Promise<string> =>
    mfaCookieOf(await loginRequest(user).expect(202));

const verifyRecovery = (cookie: string, code: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/mfa/verify")
        .set("Cookie", cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ method: "recovery", code });

const storedCodes = async (user: TestUser): Promise<string[] | undefined> =>
    (await UserModel.findById(user.id).select("+authentication.mfaRecoveryCodes").lean())
        .authentication?.mfaRecoveryCodes;

const recoveryUser = async (prefix: string): Promise<{ user: TestUser; codes: string[] }> => {
    const user: TestUser = await createTestUser(prefix);
    const { body } = await turnOnEmailMfa(user).expect(200);
    return { user, codes: body.recoveryCodes };
};

const sessionTokenHashOf = (response: supertest.Response): string =>
    hashSessionToken(
        decodeURIComponent(
            []
                .concat(response.headers["set-cookie"])
                .find((setCookie: string): boolean => setCookie.startsWith(`${sessionCookie}=`))
                .split(";")[0]
                .split("=")[1]
        )
    );

const expectOneSession = async (user: TestUser, responses: supertest.Response[]): Promise<void> => {
    const started: supertest.Response[] = responses.filter(({ status }) => status === 200);
    expect(started).toHaveLength(1);
    responses
        .filter(({ status }) => status !== 200)
        .forEach(({ status }): void => expect(status).toBe(403));
    const { authentication } = await UserModel.findById(user.id)
        .select("+authentication.sessionToken +authentication.mfaRecoveryCodes")
        .lean();
    expect(authentication.sessionToken).toBe(sessionTokenHashOf(started[0]));
    expect(authentication.mfaRecoveryCodes).toHaveLength(MFA_RECOVERY_CODES - 1);
};

describe("Recovery codes", (): void => {
    it(`should show ${MFA_RECOVERY_CODES} codes only when the first method turns on`, async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcon");

        expect(codes).toHaveLength(MFA_RECOVERY_CODES);
        expect(new Set(codes).size).toBe(MFA_RECOVERY_CODES);
        codes.forEach((code: string): void => expect(code).toMatch(recoveryCodePattern));

        const again: supertest.Response = await turnOnEmailMfa(user).expect(200);
        expect(again.body).toEqual({ message: Responses.Mfa.emailMfaOn });

        const stored: string[] = await storedCodes(user);
        expect(stored).toHaveLength(MFA_RECOVERY_CODES);
        codes.forEach((code: string): void =>
            expect(stored.join()).not.toContain(code.replace("-", ""))
        );

        const own: supertest.Response = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", user.cookie)
            .expect(200);
        expect(own.body.mfa).toEqual({
            email: true,
            passkeys: 0,
            recoveryCodesLeft: MFA_RECOVERY_CODES
        });
        const admin: supertest.Response = await request(TestData.apiURL)
            .get(`/admin/users/${user.id}`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);
        expect(admin.body.user.mfa).toEqual(own.body.mfa);
        expect(JSON.stringify([own.body, admin.body])).not.toContain("mfaRecoveryCodes");
    });

    it("should log in with a code and use it up", async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcuse");
        const cookie: string = await startMfaLogin(user);

        const response: supertest.Response = await verifyRecovery(cookie, codes[0]).expect(200);

        expect(response.body).toEqual({
            message: Responses.Authentication.loginSuccess(user.username)
        });
        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.sessionToken +authentication.mfaRecoveryCodes")
            .lean();
        expect(authentication.sessionToken).toBe(sessionTokenHashOf(response));
        expect(authentication.mfaRecoveryCodes).toHaveLength(MFA_RECOVERY_CODES - 1);
    });

    it("should refuse a code that was already used", async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcre");
        await verifyRecovery(await startMfaLogin(user), codes[0]).expect(200);
        const cookie: string = await startMfaLogin(user);

        const reused: supertest.Response = await verifyRecovery(cookie, codes[0]).expect(400);

        expect(reused.body).toEqual({ error: Responses.EmailCodes.invalidCode });
        await verifyRecovery(cookie, codes[1]).expect(200);
    });

    it("should ignore case, spaces and dashes", async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcnorm");
        const variants: string[] = [
            codes[0].toUpperCase(),
            ` ${codes[1].replace("-", "")} `,
            codes[2].replace("-", " - ").replace(/^(..)/, "$1 ")
        ];

        for (const variant of variants) {
            await verifyRecovery(await startMfaLogin(user), variant).expect(200);
        }
        expect(await storedCodes(user)).toHaveLength(MFA_RECOVERY_CODES - variants.length);
    });

    it("should replace the codes with POST /user/mfa/recovery-codes", async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcnew");

        await replaceCodes(user, {}).expect(400);
        await replaceCodes(user, { password: `${user.password}x` }).expect(403);
        const replaced: supertest.Response = await replaceCodes(user, {
            password: user.password
        }).expect(200);

        expect(replaced.body).toEqual({
            message: Responses.Mfa.recoveryCodesReplaced,
            recoveryCodes: expect.any(Array)
        });
        expect(replaced.body.recoveryCodes).toHaveLength(MFA_RECOVERY_CODES);
        replaced.body.recoveryCodes.forEach((code: string): void =>
            expect(code).toMatch(recoveryCodePattern)
        );
        const cookie: string = await startMfaLogin(user);
        await verifyRecovery(cookie, codes[0]).expect(400);
        await verifyRecovery(cookie, replaced.body.recoveryCodes[0]).expect(200);
    });

    it("should answer 409 to new codes without an MFA method on", async (): Promise<void> => {
        const user: TestUser = await createTestUser("rcnone");

        const response: supertest.Response = await replaceCodes(user, {
            password: user.password
        }).expect(409);

        expect(response.body).toEqual({ error: Responses.Mfa.noMfaMethodOn });
        expect(await storedCodes(user)).toBeUndefined();
    });

    it("should not start a challenge with only recovery codes", async (): Promise<void> => {
        const user: TestUser = await createTestUser("rconly");
        await UserModel.updateOne(
            { _id: user.id },
            { $set: { "authentication.mfaRecoveryCodes": ["0".repeat(64)] } }
        );

        await loginRequest(user).expect(200);
    });

    it("should leave recovery out of the methods once every code is used", async (): Promise<void> => {
        const { user } = await recoveryUser("rcleft");
        await UserModel.updateOne(
            { _id: user.id },
            { $set: { "authentication.mfaRecoveryCodes": [] } }
        );

        expect((await loginRequest(user).expect(202)).body).toEqual({
            mfaRequired: true,
            methods: ["email"]
        });
    });

    it("should drop the codes when the last method turns off", async (): Promise<void> => {
        const { user } = await recoveryUser("rcoff");

        await userRequest("delete", "/user/mfa/email", user, { password: user.password }).expect(
            200
        );

        expect(await storedCodes(user)).toBeUndefined();
        const { body } = await turnOnEmailMfa(user).expect(200);
        expect(body.recoveryCodes).toHaveLength(MFA_RECOVERY_CODES);
    });

    it("should start one session and use one code from parallel uses of one code", async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcpar");
        const cookie: string = await startMfaLogin(user);

        await expectOneSession(
            user,
            await Promise.all(Array.from({ length: 12 }, () => verifyRecovery(cookie, codes[0])))
        );
    });

    it("should use up only the code that started the session from parallel different codes", async (): Promise<void> => {
        const { user, codes } = await recoveryUser("rcdif");
        const cookie: string = await startMfaLogin(user);

        await expectOneSession(
            user,
            await Promise.all(codes.slice(0, 9).map((code: string) => verifyRecovery(cookie, code)))
        );
    });

    it("should refuse another account's code", async (): Promise<void> => {
        const [owner, other] = await Promise.all([recoveryUser("rcown"), recoveryUser("rcoth")]);

        await verifyRecovery(await startMfaLogin(other.user), owner.codes[0]).expect(400);

        expect(await storedCodes(owner.user)).toHaveLength(MFA_RECOVERY_CODES);
    });

    it("should keep MFA and the codes through a password reset", async (): Promise<void> => {
        const { user } = await recoveryUser("rcpr");
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
        const newPassword: string = `${user.password}new`;

        await request(TestData.apiURL)
            .post("/auth/password-reset/confirm")
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email: user.email, code, newPassword })
            .expect(200);

        const { authentication } = await UserModel.findById(user.id)
            .select("+authentication.mfaEmail +authentication.mfaRecoveryCodes")
            .lean();
        expect(authentication.mfaEmail).toBe(true);
        expect(authentication.mfaRecoveryCodes).toHaveLength(MFA_RECOVERY_CODES);
        expect((await loginRequest({ ...user, password: newPassword }).expect(202)).body).toEqual({
            mfaRequired: true,
            methods: ["email", "recovery"]
        });
    });

    it("should need a recent GitHub confirmation for new codes without a password", async (): Promise<void> => {
        const user: TestUser = await createTestUser("rcgh");
        await linkGithub(user, true);
        await turnOnEmailMfaInDb(user);

        const response: supertest.Response = await replaceCodes(user, {}).expect(403);

        expect(response.body).toEqual({
            error: Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
        });
        expect(await storedCodes(user)).toBeUndefined();
    });
});
