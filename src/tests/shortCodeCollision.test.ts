import express from "express";
import mongoose from "mongoose";
import { Responses } from "../constants/responses";
import { SHORT_URL_CODE_ATTEMPTS, SHORT_URL_CODE_LENGTH } from "../constants/limits";
import { shortenUrl } from "../controllers/shortenUrls";
import * as shortUrlsDatabase from "../database/shortUrls";
import * as usersDatabase from "../database/users";
import * as textHelpers from "../helpers/text";

const takenCode: string = "taken1";
const freshCode: string = "fresh1";

const codeCollision: Error = Object.assign(new Error("E11000 duplicate key error"), {
    code: 11000,
    keyPattern: { shortenedUrl: 1 }
});

interface FakeResponse {
    statusCode: number;
    status: jest.Mock;
    sendStatus: jest.Mock;
    json: jest.Mock;
}

const fakeResponse = (): FakeResponse => {
    const res = {} as FakeResponse;
    const setStatus = (code: number): FakeResponse => {
        res.statusCode = code;
        return res;
    };
    res.status = jest.fn(setStatus);
    res.sendStatus = jest.fn(setStatus);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const runShortenUrl = async (): Promise<FakeResponse> => {
    const req = {
        body: { url: "https://collision.vb2007.test/" },
        identity: { _id: new mongoose.Types.ObjectId().toString() }
    } as unknown as express.Request;
    const res: FakeResponse = fakeResponse();
    await shortenUrl(req, res as unknown as express.Response);
    return res;
};

describe("Short Code Collision Tests", (): void => {
    let createShortUrl: jest.SpyInstance;

    beforeEach((): void => {
        jest.spyOn(console, "error").mockImplementation((): void => undefined);
        jest.spyOn(shortUrlsDatabase, "getShortUrlByUser").mockResolvedValue(null);
        jest.spyOn(usersDatabase, "getUserById").mockResolvedValue({} as never);
        jest.spyOn(textHelpers, "generateRandomString")
            .mockReturnValueOnce(takenCode)
            .mockReturnValue(freshCode);
        createShortUrl = jest.spyOn(shortUrlsDatabase, "createShortUrl");
    });

    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should retry a colliding short code with a fresh one", async (): Promise<void> => {
        createShortUrl
            .mockRejectedValueOnce(codeCollision)
            .mockImplementation(async (values: object) => ({ ...values, addedOn: new Date() }));

        const res: FakeResponse = await runShortenUrl();

        expect(textHelpers.generateRandomString).toHaveBeenCalledWith(SHORT_URL_CODE_LENGTH);
        expect(createShortUrl).toHaveBeenCalledTimes(2);
        expect(res.statusCode).toBe(201);
        expect(res.json).toHaveBeenCalledWith({
            message: Responses.ShortenUrl.urlShortenedSuccess,
            data: expect.objectContaining({ shortenedUrl: freshCode })
        });
    });

    it("should give up after the maximum number of colliding short codes", async (): Promise<void> => {
        createShortUrl.mockRejectedValue(codeCollision);

        const res: FakeResponse = await runShortenUrl();

        expect(createShortUrl).toHaveBeenCalledTimes(SHORT_URL_CODE_ATTEMPTS);
        expect(res.statusCode).toBe(500);
        expect(console.error).toHaveBeenCalledWith(codeCollision);
    });
});
