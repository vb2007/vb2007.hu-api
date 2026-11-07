import express from "express";
import { resendRegistrationCode } from "../../controllers/authentication";

export interface HandlerAnswer {
    status: number;
    body: unknown;
}

type EmailHandler = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => Promise<unknown>;

export const runEmailHandler = async (
    handler: EmailHandler,
    email: string
): Promise<HandlerAnswer> => {
    const answer: HandlerAnswer = { status: 0, body: undefined };
    const res = {
        status: (status: number) => {
            answer.status = status;
            return res;
        },
        json: (body: unknown) => {
            answer.body = body;
            return res;
        }
    };

    await handler(
        { body: { email } } as express.Request,
        res as unknown as express.Response,
        jest.fn()
    );

    return answer;
};

export const runResendRegistration = (email: string): Promise<HandlerAnswer> =>
    runEmailHandler(resendRegistrationCode, email);
