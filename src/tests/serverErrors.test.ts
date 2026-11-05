import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import { get } from "lodash";
import { Responses } from "../constants/responses";
import {
    checkUploadQuota,
    handleRequestError,
    handleUpload,
    isAuthenticated,
    isPasteOwner
} from "../middlewares";
import { githubStartLink, githubUnlink } from "../controllers/authentication";
import { deletePaste } from "../controllers/pastebin";
import {
    changeEmail,
    changePassword,
    getUser,
    setPassword,
    updateUser
} from "../controllers/users";
import * as pastebinDatabase from "../database/pastebin";
import * as usersDatabase from "../database/users";
import * as githubHelpers from "../helpers/github";
import * as passwordHelpers from "../helpers/password";
import * as uploadQuota from "../helpers/uploadQuota";
import * as userUploadsHelpers from "../helpers/userUploads";
import { upload } from "../helpers/multer";
import { sessionCookie } from "../helpers/session";

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
        cookies: { [sessionCookie]: "session-token" },
        identity: { _id: new mongoose.Types.ObjectId(), email: "user@local.test" },
        ...fields
    }) as unknown as express.Request;

const run = async (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown,
    req: express.Request
): Promise<FakeResponse> => {
    const res: FakeResponse = fakeResponse();
    const next: jest.Mock = jest.fn((error?: Error): void => {
        if (error) {
            handleRequestError(error, req, res as unknown as express.Response, jest.fn());
        }
    });
    await handler(req, res as unknown as express.Response, next);
    await new Promise(setImmediate);
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
        jest.spyOn(userUploadsHelpers, "discardUpload").mockResolvedValue();
    });

    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("should hide the error of a failing request", (): void => {
        const res: FakeResponse = fakeResponse();

        handleRequestError(
            internalError,
            fakeRequest({}),
            res as unknown as express.Response,
            jest.fn()
        );

        expectGenericServerError(res);
    });

    it("should answer 500 to a failing request with a status of its own", (): void => {
        const statusError: Error = Object.assign(new Error("Unauthorized upstream"), {
            status: 401
        });
        const res: FakeResponse = fakeResponse();

        handleRequestError(
            statusError,
            fakeRequest({}),
            res as unknown as express.Response,
            jest.fn()
        );

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: Responses.internalServerError });
        expect(console.error).toHaveBeenCalledWith(statusError);
    });

    it("should hide the error of a failing session check", async (): Promise<void> => {
        jest.spyOn(usersDatabase, "getUserBySessionToken").mockRejectedValue(internalError);

        expectGenericServerError(await run(isAuthenticated, fakeRequest({})));
    });

    it("should hide the error of a failing user lookup", async (): Promise<void> => {
        jest.spyOn(usersDatabase, "getUserBySessionToken").mockImplementation((): never => {
            throw internalError;
        });

        expectGenericServerError(await run(getUser, fakeRequest({})));
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

const lookUpUser = (user: object | null): void => {
    jest.spyOn(usersDatabase, "getUserById").mockReturnValue(
        Object.assign(Promise.resolve(user), {
            select: (): Promise<object | null> => Promise.resolve(user)
        }) as never
    );
};

const deletedBeforeSave = (authentication: object): object => ({
    _id: new mongoose.Types.ObjectId(),
    githubId: "1",
    authentication,
    save: jest.fn().mockRejectedValue(new mongoose.Error.DocumentNotFoundError("{}"))
});

const ownAccountRequest = (fields: object): express.Request => {
    const req: express.Request = fakeRequest(fields);
    req.params = { id: get(req, "identity._id").toString() };
    return req;
};

const expectNotLoggedIn = (res: FakeResponse): void => {
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: Responses.notLoggedIn });
};

describe("Vanished Account Tests", (): void => {
    beforeEach((): void => {
        jest.spyOn(usersDatabase, "getUserByUsername").mockResolvedValue(null as never);
        jest.spyOn(usersDatabase, "setPasswordIfUnset").mockResolvedValue({
            matchedCount: 1
        } as never);
        jest.spyOn(githubHelpers, "isGithubConfigured").mockReturnValue(true);
        jest.spyOn(passwordHelpers, "hashPassword").mockResolvedValue("password-hash");
        jest.spyOn(passwordHelpers, "verifyPassword").mockResolvedValue(true);
    });

    afterEach((): void => {
        jest.restoreAllMocks();
    });

    const password: string = "vanished-password";
    const passwordChange: object = { body: { currentPassword: password, newPassword: password } };

    it.each([
        ["updateUser", updateUser, { body: { username: "vanished" } }],
        ["setPassword", setPassword, { body: { password } }],
        ["changePassword", changePassword, passwordChange],
        ["changeEmail", changeEmail, { body: { email: "vanished@local.test", password } }],
        ["githubStartLink", githubStartLink, { body: { password } }],
        ["githubUnlink", githubUnlink, { body: { password } }]
    ])(
        "should answer 403 from %s when the account is deleted before its lookup",
        async (name, handler, fields): Promise<void> => {
            lookUpUser(null);

            expectNotLoggedIn(await run(handler, ownAccountRequest(fields)));
        }
    );

    it.each([
        ["updateUser", updateUser, { body: { username: "vanished" } }, {}],
        ["setPassword", setPassword, { body: { password } }, { githubVerifiedAt: new Date() }],
        ["changePassword", changePassword, passwordChange, { salt: "salt", password }],
        ["githubUnlink", githubUnlink, { body: { password } }, { salt: "salt", password }]
    ])(
        "should answer 403 from %s when the account is deleted before it is saved",
        async (name, handler, fields, authentication): Promise<void> => {
            lookUpUser(deletedBeforeSave(authentication));

            expectNotLoggedIn(await run(handler, ownAccountRequest(fields)));
        }
    );
});
