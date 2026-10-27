import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import { Responses } from "../constants/responses";
import { checkUploadQuota, handleUpload, isPasteOwner } from "../middlewares";
import { deletePaste } from "../controllers/pastebin";
import * as pastebinDatabase from "../database/pastebin";
import * as uploadQuota from "../helpers/uploadQuota";
import { upload } from "../helpers/multer";

const internalError: NodeJS.ErrnoException = Object.assign(
    new Error("ENOENT: no such file or directory, open '/srv/uploads/user/upload.txt'"),
    { code: "ENOENT" }
);

interface FakeResponse {
    status: jest.Mock;
    json: jest.Mock;
}

const fakeResponse = (): FakeResponse => {
    const res = {} as FakeResponse;
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const fakeRequest = (fields: object): express.Request =>
    ({
        params: {},
        identity: { _id: new mongoose.Types.ObjectId(), email: "user@local.test" },
        ...fields
    }) as unknown as express.Request;

const run = async (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown,
    req: express.Request
): Promise<FakeResponse> => {
    const res: FakeResponse = fakeResponse();
    await handler(req, res as unknown as express.Response, jest.fn());
    return res;
};

const expectGenericServerError = (res: FakeResponse): void => {
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ error: Responses.internalServerError });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("/srv/uploads");
    expect(console.error).toHaveBeenCalledWith(internalError);
};

describe("Server Error Response Tests", (): void => {
    beforeEach((): void => {
        jest.spyOn(console, "error").mockImplementation((): void => undefined);
    });

    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should hide the error of a failing upload quota check", async (): Promise<void> => {
        jest.spyOn(uploadQuota, "exceedsUploadQuota").mockRejectedValue(internalError);

        const req: express.Request = fakeRequest({
            file: { path: "/nonexistent/upload.txt", size: 1 }
        });

        expectGenericServerError(await run(checkUploadQuota, req));
    });

    it("should hide the error of a failing paste lookup", async (): Promise<void> => {
        jest.spyOn(pastebinDatabase, "findPasteById").mockRejectedValue(internalError);

        const req: express.Request = fakeRequest({
            params: { id: new mongoose.Types.ObjectId().toString() }
        });

        expectGenericServerError(await run(isPasteOwner, req));
    });

    it("should hide the error of a failing paste deletion", async (): Promise<void> => {
        jest.spyOn(pastebinDatabase, "deletePasteById").mockRejectedValue(internalError);

        const req: express.Request = fakeRequest({
            paste: { _id: new mongoose.Types.ObjectId() }
        });

        expectGenericServerError(await run(deletePaste, req));
    });

    it("should hide the error of a failing file upload", async (): Promise<void> => {
        jest.spyOn(upload, "single").mockReturnValue(((req, res, callback) =>
            callback(internalError)) as express.RequestHandler);

        expectGenericServerError(await run(handleUpload, fakeRequest({})));
    });

    it("should keep the message of a rejected file upload", async (): Promise<void> => {
        const multerError: multer.MulterError = new multer.MulterError("LIMIT_UNEXPECTED_FILE");
        jest.spyOn(upload, "single").mockReturnValue(((req, res, callback) =>
            callback(multerError)) as express.RequestHandler);

        const res: FakeResponse = await run(handleUpload, fakeRequest({}));

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: multerError.message });
    });
});
