import express from "express";
import { SecurityChanges } from "../constants/emails";
import { SECURITY_NOTICES_PER_DAY } from "../constants/limits";
import { disableEmailMfa, enableEmailMfa } from "../controllers/mfa";
import {
    deletePasskeyById,
    finishPasskeyRegistration,
    startPasskeyRegistration
} from "../controllers/passkeys";
import * as mail from "../helpers/mail";
import { passkeyRegistrationCookie } from "../helpers/passkeys";
import { sessionCookie } from "../helpers/session";
import { SoftwareAuthenticator } from "./helpers/passkeys";
import { TestUser, createTestUser, isolatedClientIp, sessionTokenOf } from "./helpers/testUsers";

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

const addPasskey = async (user: TestUser, name: string): Promise<Answer> => {
    const options: Answer = await run(startPasskeyRegistration, user);
    expect(options.status).toBe(200);

    return run(finishPasskeyRegistration, user, {
        body: { name, response: new SoftwareAuthenticator().register(options.body) },
        cookies: { [passkeyRegistrationCookie]: options.cookies[passkeyRegistrationCookie] }
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
        expect(sent.text).toContain(`${change} on `);
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

    it("should mail once when a passkey is added, with its name, and once when it's deleted", async (): Promise<void> => {
        const user: TestUser = await createTestUser("snpk");

        const added: Answer = await addPasskey(user, "Work\nlaptop");
        expect(added.status).toBe(201);
        expectOneNotice(
            user,
            'A passkey named "Work\\nlaptop" was added to your vb2007.hu account'
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
        } finally {
            consoleWarn.mockRestore();
        }
    });
});
