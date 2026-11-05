import express from "express";
import { requestPasswordReset } from "../../controllers/authentication";

interface HandlerAnswer {
    status: number;
    body: unknown;
}

export const runRequestReset = async (email: string): Promise<HandlerAnswer> => {
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

    await requestPasswordReset(
        { body: { email } } as express.Request,
        res as unknown as express.Response,
        jest.fn()
    );

    return answer;
};
