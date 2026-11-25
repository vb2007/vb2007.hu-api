import express from "express";
import request from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { SecurityChanges } from "../constants/emails";
import { MFA_RECOVERY_CODES, SECURITY_NOTICES_PER_DAY } from "../constants/limits";
import { resetUserMfa, revokeUserApiKeys } from "../controllers/admin";
import * as apiKeysDatabase from "../database/apiKeys";
import { User } from "../database/users";
import { newObjectId } from "../helpers/prisma";
import { createApiKey, deleteApiKeyById, rotateApiKeyById } from "../controllers/apiKeys";
import { disableEmailMfa, enableEmailMfa, verifyMfa } from "../controllers/mfa";
import { confirmTotpMfa, disableTotpMfa, startTotpSetup } from "../controllers/mfaTotp";
import { fromBase32, totpCode, totpStepAt } from "../helpers/mfaTotp";
import { replaceMfaRecoveryCodes } from "../controllers/mfaRecovery";
import { githubUnlink } from "../controllers/authentication";
import {
    deletePasskeyById,
    finishPasskeyRegistration,
    startPasskeyRegistration
} from "../controllers/passkeys";
import * as mail from "../helpers/mail";
import { mfaCookie } from "../helpers/mfa";
import { passkeyRegistrationCookie } from "../helpers/passkeys";
import { sessionCookie } from "../helpers/session";
import { mfaCookieOf } from "./helpers/mfa";
import { SoftwareAuthenticator } from "./helpers/passkeys";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    sessionTokenOf,
    storedAuthentication,
    updateStoredUser
} from "./helpers/testUsers";

type Handler = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => Promise<unknown>;

interface Answer {
    status: number;
    body: any;
    cookies: Record<string, string>;
}

const run = async (
    handler: Handler,
    user: TestUser,
    fields: { body?: object; params?: object; cookies?: object } = {}
): Promise<Answer> => {
    const answer: Answer = { status: 0, body: undefined, cookies: {} };
    const res = {
        locals: {},
        status: (status: number) => {
            answer.status = status;
            return res;
        },
        json: (body: unknown) => {
            answer.body = body;
            return res;
        },
        cookie: (name: string, value: string) => {
            answer.cookies[name] = value;
            return res;
        },
        set: () => res,
        clearCookie: () => res
    };
    const next: jest.Mock = jest.fn();

    await handler(
        {
            ip: isolatedClientIp(),
            identity: { _id: user.id, email: user.email, username: user.username },
            params: {},
            body: { password: user.password },
            ...fields,
            cookies: { [sessionCookie]: sessionTokenOf(user.cookie), ...fields.cookies }
        } as unknown as express.Request,
        res as unknown as express.Response,
        next
    );

    expect(next).not.toHaveBeenCalled();
    return answer;
};

const addPasskey = async (
    user: TestUser,
    name: string,
    authenticator: SoftwareAuthenticator = new SoftwareAuthenticator()
): Promise<Answer> => {
    const options: Answer = await run(startPasskeyRegistration, user);
    expect(options.status).toBe(200);

    return run(finishPasskeyRegistration, user, {
        body: { name, response: authenticator.register(options.body) },
        cookies: { [passkeyRegistrationCookie]: options.cookies[passkeyRegistrationCookie] }
    });
};

const verifyMfaLogin = async (user: TestUser, body: object): Promise<Answer> => {
    const login = await request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email: user.email, password: user.password })
        .expect(202);

    return run(verifyMfa, user, {
        body,
        cookies: { [mfaCookie]: mfaCookieOf(login).split("=")[1] }
    });
};

describe("Security notice mails", (): void => {
    let sendMail: jest.SpyInstance;

    beforeEach((): void => {
        sendMail = jest.spyOn(mail, "sendMail").mockResolvedValue();
    });

    afterEach((): void => {
        sendMail.mockRestore();
    });

    const expectOneNotice = (user: TestUser, change: string): void => {
        expect(sendMail).toHaveBeenCalledTimes(1);
        const [[sent]] = sendMail.mock.calls;
        expect(sent.to).toBe(user.email);
        expect(sent.subject).toBe("Your vb2007.hu account's security settings changed");
        expect(sent.text).toContain(`Hi ${user.username},`);
        expect(sent.text).toContain(`${change}.\nWhen: `);
        expect(sent.text).toContain("reset your password");
        sendMail.mockClear();
    };

    it("should mail once when e-mail MFA is turned on or off, and not for a no-op", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snmfa");

        expect((await run(enableEmailMfa, user)).status).toBe(200);
        expectOneNotice(user, SecurityChanges.emailMfaOn);

        expect((await run(enableEmailMfa, user)).status).toBe(200);
        expect(sendMail).not.toHaveBeenCalled();

        expect((await run(disableEmailMfa, user)).status).toBe(200);
        expectOneNotice(user, SecurityChanges.emailMfaOff);

        expect((await run(disableEmailMfa, user)).status).toBe(200);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail once when new recovery codes replace the old ones", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snrec");
        expect((await run(enableEmailMfa, user)).status).toBe(200);
        sendMail.mockClear();

        expect((await run(replaceMfaRecoveryCodes, user)).status).toBe(200);
        expectOneNotice(user, SecurityChanges.recoveryCodesReplaced);
    });

    const expectRecoveryLoginNotice = (user: TestUser, left: string): void => {
        expect(sendMail).toHaveBeenCalledTimes(1);
        const [[sent]] = sendMail.mock.calls;
        expect(sent.to).toBe(user.email);
        expect(sent.subject).toBe("New login to your vb2007.hu account");
        expect(sent.text).toContain(
            `A recovery code was used to log in to your vb2007.hu account, and ${left}.\nWhen: `
        );
        sendMail.mockClear();
    };

    it("should mail the codes left after a recovery code login, and not for a wrong code", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snrlog");
        const { recoveryCodes } = (await run(enableEmailMfa, user)).body;
        sendMail.mockClear();

        const wrong: Answer = await verifyMfaLogin(user, {
            method: "recovery",
            code: "aaaaa-aaaaa"
        });
        expect(wrong.status).toBe(400);
        expect(sendMail).not.toHaveBeenCalled();

        expect(
            (await verifyMfaLogin(user, { method: "recovery", code: recoveryCodes[0] })).status
        ).toBe(200);
        expectRecoveryLoginNotice(
            user,
            `${MFA_RECOVERY_CODES - 1} recovery codes are left: if it wasn't you, make new ones in your account settings`
        );

        const authentication = await storedAuthentication(user.id);
        await updateStoredUser(user.id, (f) => [
            f("authentication.mfaRecoveryCodes").set(authentication.mfaRecoveryCodes.slice(-1))
        ]);

        expect(
            (
                await verifyMfaLogin(user, {
                    method: "recovery",
                    code: recoveryCodes[MFA_RECOVERY_CODES - 1]
                })
            ).status
        ).toBe(200);
        expectRecoveryLoginNotice(
            user,
            "it was the last one: make new ones in your account settings"
        );
        expect(SecurityChanges.recoveryCodeLogin(1)).toContain(
            ", and 1 recovery code is left: if it wasn't you, make new ones in your account settings"
        );
    });

    it("should not mail after a TOTP login", async (): Promise<void> => {
        const user: TestUser = await createTestUser("sntlog");
        const setup: Answer = await run(startTotpSetup, user);
        const key: Buffer = fromBase32(setup.body.secret);
        const step: number = totpStepAt(Date.now());
        expect(
            (await run(confirmTotpMfa, user, { body: { code: totpCode(key, step) } })).status
        ).toBe(200);
        sendMail.mockClear();

        expect(
            (await verifyMfaLogin(user, { method: "totp", code: totpCode(key, step + 1) })).status
        ).toBe(200);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail once for concurrent changes to the same state", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snrace");

        for (const [handler, change] of [
            [enableEmailMfa, SecurityChanges.emailMfaOn],
            [disableEmailMfa, SecurityChanges.emailMfaOff]
        ] as const) {
            const answers: Answer[] = await Promise.all(
                Array.from({ length: 5 }, () => run(handler, user))
            );

            expect(answers.map(({ status }) => status)).toEqual([200, 200, 200, 200, 200]);
            expectOneNotice(user, change);
        }
    });

    it("should mail once when a passkey is added, with its name, and once when it's deleted", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snpk");

        const added: Answer = await addPasskey(user, 'Work "laptop"');
        expect(added.status).toBe(201);
        expectOneNotice(
            user,
            'A passkey named "Work \\"laptop\\"" was added to your vb2007.hu account'
        );

        const deleted: Answer = await run(deletePasskeyById, user, {
            params: { id: added.body.passkey.id }
        });
        expect(deleted.status).toBe(200);
        expectOneNotice(user, SecurityChanges.passkeyDeleted);

        expect(
            (await run(deletePasskeyById, user, { params: { id: added.body.passkey.id } })).status
        ).toBe(404);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail once when GitHub is unlinked, and not when it's no longer linked", async (): Promise<void> => {
        const user: TestUser = await createTestUser("sngh");
        await linkGithub(user);

        expect((await run(githubUnlink, user)).status).toBe(200);
        expectOneNotice(user, SecurityChanges.githubUnlinked);

        expect((await run(githubUnlink, user)).status).toBe(404);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should not mail when the guarded write refuses the change", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snrej");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();

        expect((await addPasskey(user, "Laptop", authenticator)).status).toBe(201);
        sendMail.mockClear();

        expect((await addPasskey(user, "Laptop", authenticator)).status).toBe(409);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail once when TOTP is turned on, moved or off, and not for a no-op or a wrong code", async (): Promise<void> => {
        const user: TestUser = await createTestUser("sntotp");
        const setup: Answer = await run(startTotpSetup, user);
        expect(setup.status).toBe(200);
        const code: string = totpCode(fromBase32(setup.body.secret), totpStepAt(Date.now()));

        expect((await run(confirmTotpMfa, user, { body: { code: "abcdef" } })).status).toBe(400);
        expect(sendMail).not.toHaveBeenCalled();

        expect((await run(confirmTotpMfa, user, { body: { code } })).status).toBe(200);
        expectOneNotice(user, SecurityChanges.totpMfaOn);

        const replaced: Answer = await run(startTotpSetup, user);
        const newCode: string = totpCode(fromBase32(replaced.body.secret), totpStepAt(Date.now()));
        expect((await run(confirmTotpMfa, user, { body: { code: newCode } })).status).toBe(200);
        expectOneNotice(user, SecurityChanges.totpSecretChanged);

        expect((await run(disableTotpMfa, user)).status).toBe(200);
        expectOneNotice(user, SecurityChanges.totpMfaOff);

        expect((await run(disableTotpMfa, user)).status).toBe(200);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail when an API key is created, rotated or deleted, saying when it has admin scopes", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snak");
        const superuser: TestUser = {
            id: TestData.superuser.id,
            username: TestData.superuser.username,
            email: TestData.superuser.email,
            password: TestData.superuser.password,
            cookie: TestData.superuser.cookie
        };

        for (const [owner, scopes, admin] of [
            [user, ["pastes:read"], false],
            [superuser, ["pastes:read", "admin:read"], true]
        ] as [TestUser, string[], boolean][]) {
            const created: Answer = await run(createApiKey, owner, {
                body: { name: "Bot", scopes, password: owner.password }
            });
            expect(created.status).toBe(201);
            expectOneNotice(owner, SecurityChanges.apiKeyCreated("Bot", admin));

            const params = { id: created.body.apiKey.id };
            expect((await run(rotateApiKeyById, owner, { params })).status).toBe(200);
            expectOneNotice(owner, SecurityChanges.apiKeyRotated("Bot", admin));

            expect((await run(deleteApiKeyById, owner, { params })).status).toBe(200);
            expectOneNotice(owner, SecurityChanges.apiKeyDeleted("Bot"));

            expect((await run(deleteApiKeyById, owner, { params })).status).toBe(404);
            expect(sendMail).not.toHaveBeenCalled();
        }

        expect(SecurityChanges.apiKeyCreated("Bot", false)).not.toContain("admin");
        expect(SecurityChanges.apiKeyCreated("Bot", true)).toBe(
            'An API key named "Bot", with admin scopes that can manage the whole site, was created for your vb2007.hu account'
        );
        expect(SecurityChanges.apiKeyRotated("Bot", true)).toBe(
            'The API key named "Bot", with admin scopes that can manage the whole site, of your vb2007.hu account got a new token, and the old one no longer works'
        );
    });

    it("should not create or rotate an API key from an ended session, and mail nothing", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snaks");
        const body = { name: "Bot", scopes: ["pastes:read"], password: user.password };
        const created: Answer = await run(createApiKey, user, { body });
        expect(created.status).toBe(201);
        sendMail.mockClear();
        const [before] = (await storedAuthentication(user.id)).apiKeys;
        const ended = { cookies: { [sessionCookie]: "ended-session" } };

        const refused: Answer = await run(createApiKey, user, { body, ...ended });
        expect(refused).toMatchObject({ status: 403, body: { error: Responses.notLoggedIn } });

        const params = { id: created.body.apiKey.id };
        const notRotated: Answer = await run(rotateApiKeyById, user, { params, ...ended });
        expect(notRotated).toMatchObject({ status: 403, body: { error: Responses.notLoggedIn } });

        expect((await storedAuthentication(user.id)).apiKeys).toEqual([before]);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail once when the admin resets MFA, and not for an unknown user", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snrst");

        expect((await run(resetUserMfa, user, { params: { id: user.id } })).status).toBe(200);
        expectOneNotice(user, SecurityChanges.mfaReset);

        expect(
            (await run(resetUserMfa, user, { params: { id: "0123456789abcdef01234567" } })).status
        ).toBe(404);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should mail once when the admin revokes a user's API keys, and not when there were none", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snakr");
        const body = { name: "Bot", scopes: ["pastes:read"], password: user.password };
        expect((await run(createApiKey, user, { body })).status).toBe(201);
        sendMail.mockClear();
        const params = { id: user.id };

        const revoked: Answer = await run(revokeUserApiKeys, user, { params });
        expect(revoked).toMatchObject({ status: 200, body: { revoked: 1 } });
        expectOneNotice(user, SecurityChanges.apiKeysRevoked);

        const none: Answer = await run(revokeUserApiKeys, user, { params });
        expect(none).toMatchObject({ status: 200, body: { revoked: 0 } });
        expect((await run(revokeUserApiKeys, user, { params: { id: newObjectId() } })).status).toBe(
            404
        );
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("should revoke the superuser's own API keys like anyone else's", async (): Promise<void> => {
        const superuser: TestUser = {
            id: TestData.superuser.id,
            username: TestData.superuser.username,
            email: TestData.superuser.email,
            password: TestData.superuser.password,
            cookie: TestData.superuser.cookie
        };
        const noticeHolder: TestUser = await createTestUser("snaksu");
        const removeAllApiKeys: jest.SpyInstance = jest
            .spyOn(apiKeysDatabase, "removeAllApiKeys")
            .mockResolvedValue({
                _id: noticeHolder.id,
                username: superuser.username,
                email: superuser.email,
                authentication: { apiKeys: [{ id: "a" }] }
            } as unknown as User);

        try {
            const params = { id: superuser.id };
            const revoked: Answer = await run(revokeUserApiKeys, superuser, { params });
            expect(revoked).toMatchObject({ status: 200, body: { revoked: 1 } });
            expect(removeAllApiKeys).toHaveBeenCalledWith(superuser.id);
            expectOneNotice(superuser, SecurityChanges.apiKeysRevoked);
        } finally {
            removeAllApiKeys.mockRestore();
        }
    });

    it("should still answer success when the notice can't be sent", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snfail");
        sendMail.mockRejectedValue(new Error("SMTP down"));
        const consoleError: jest.SpyInstance = jest
            .spyOn(console, "error")
            .mockImplementation((): void => undefined);

        try {
            expect((await run(enableEmailMfa, user)).status).toBe(200);
            expect(sendMail).toHaveBeenCalledTimes(1);
            expect(consoleError).toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it("should stop mailing at the daily notice cap and still make the change", async (): Promise<void> => {
        const user: TestUser = await createTestUser("sncap");
        const consoleWarn: jest.SpyInstance = jest
            .spyOn(console, "warn")
            .mockImplementation((): void => undefined);

        try {
            for (let toggle = 0; toggle < SECURITY_NOTICES_PER_DAY + 2; toggle++) {
                const handler: Handler = toggle % 2 === 0 ? enableEmailMfa : disableEmailMfa;
                expect((await run(handler, user)).status).toBe(200);
            }

            expect(sendMail).toHaveBeenCalledTimes(SECURITY_NOTICES_PER_DAY);
            expect(consoleWarn).toHaveBeenCalledWith(
                `Security notice not sent: ${SECURITY_NOTICES_PER_DAY} a day per account used up`
            );

            const cleared = await request(TestData.apiURL)
                .delete("/admin/rate-limits")
                .set("Cookie", TestData.superuser.cookie)
                .send({ email: user.email })
                .expect(200);
            expect(cleared.body.cleared).toContain("securityNotices");

            sendMail.mockClear();
            expect((await run(enableEmailMfa, user)).status).toBe(200);
            expectOneNotice(user, SecurityChanges.emailMfaOn);
        } finally {
            consoleWarn.mockRestore();
        }
    });
});
