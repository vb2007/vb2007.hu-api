import express from "express";
import supertest from "supertest";
import { sendMfaEmail } from "../../controllers/mfa";
import * as mail from "../../helpers/mail";
import { mfaCookie } from "../../helpers/mfa";
import { TestUser, updateStoredUser } from "./testUsers";

export interface MailedMfaEmail {
    to: string;
    code: string;
    link: string;
    token: string;
}

export const mfaCookieOf = (response: supertest.Response): string | undefined =>
    []
        .concat(response.headers["set-cookie"] ?? [])
        .find((setCookie: string): boolean => setCookie.startsWith(`${mfaCookie}=`))
        ?.split(";")[0];

export const turnOnEmailMfa = async (user: TestUser): Promise<void> => {
    await updateStoredUser(user.id, (f) => [f("authentication.mfaEmail").set(true)]);
};

export const runSendMfaEmail = async (cookie: string): Promise<number> => {
    const answer: { status: number; body?: unknown } = { status: 0 };
    const res = {
        status: (status: number) => {
            answer.status = status;
            return res;
        },
        json: (body: unknown) => {
            answer.body = body;
            return res;
        },
        set: () => res,
        clearCookie: () => res
    };

    await sendMfaEmail(
        { cookies: { [mfaCookie]: cookie.split("=")[1] }, body: {} } as express.Request,
        res as unknown as express.Response,
        jest.fn()
    );

    return answer.status;
};

export const mailedMfaEmail = async (cookie: string): Promise<MailedMfaEmail> => {
    const sendMail: jest.SpyInstance = jest.spyOn(mail, "sendMail").mockResolvedValue();

    try {
        const status: number = await runSendMfaEmail(cookie);

        if (status !== 202) {
            throw new Error(`POST /auth/mfa/email answered ${status}`);
        }

        const [[sent]] = sendMail.mock.calls;
        const link: string = sent.text.match(/^https?:\/\/\S+\/login\/mfa#token=\S+$/m)[0];

        return {
            to: sent.to,
            code: sent.text.match(/: (\d{6})$/m)[1],
            link,
            token: link.split("#token=")[1]
        };
    } finally {
        sendMail.mockRestore();
    }
};
