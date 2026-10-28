import request from "supertest";
import supertest from "supertest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { TestData } from "../../constants/testData";
import { UserModel } from "../../database/users";
import { PastebinModel } from "../../database/pastebin";
import { ShortUrlModel } from "../../database/shortUrls";
import { UserUploadsModel } from "../../database/userUploads";
import {
    PendingRegistrationModel,
    registrationCodeScope
} from "../../database/pendingRegistrations";
import { createEmailCode, hashEmailCode } from "../../helpers/emailCodes";
import { normalizeEmail } from "../../helpers";

export interface TestUser {
    id: string;
    username: string;
    email: string;
    password: string;
    cookie: string;
}

export const randomHex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex");

export const isolatedClientIp = (): string => `2001:db8:${randomHex(2)}::1`;

export const registerRequest = (
    body: Record<string, unknown>,
    clientIp: string = isolatedClientIp()
): supertest.Test =>
    request(TestData.apiURL).post("/auth/register").set("X-Forwarded-For", clientIp).send(body);

export const setRegistrationCode = async (email: string): Promise<string> => {
    const normalizedEmail: string = normalizeEmail(email);
    const code: string = createEmailCode();

    await PendingRegistrationModel.updateOne(
        { email: normalizedEmail },
        { $set: { "code.hash": hashEmailCode(registrationCodeScope(normalizedEmail), code) } }
    );

    return code;
};

export const verifyRegistration = (email: string, code: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/register/verify")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email, code });

export const testEmailOf = (username: string, domain: string = TestData.emailDomain): string =>
    `${username.toLowerCase()}@${domain}`;

export const testEmailOfLength = (length: number): string =>
    testEmailOf(randomHex(5).padEnd(length - TestData.emailDomain.length - 1, "a"));

const expectStatus = (response: supertest.Response, status: number, action: string): void => {
    if (response.status !== status) {
        throw new Error(`${action} answered ${response.status}: ${response.text}`);
    }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const emailsEndingWith = (suffix: string): RegExp =>
    new RegExp(`${escapeRegExp(suffix)}$`, "i");

export const login = async (email: string, password: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/login")
        .send({ email, password });

    expectStatus(response, 200, "POST /auth/login");

    return response.headers["set-cookie"][0];
};

export const currentUserId = async (cookie: string): Promise<string> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .get("/user")
        .set("Cookie", cookie);

    expectStatus(response, 200, "GET /user");

    return response.body._id;
};

export const registerTestUser = async (
    username: string,
    email: string = testEmailOf(username)
): Promise<TestUser> => {
    const password: string = randomHex(12);

    expectStatus(await registerRequest({ username, email, password }), 202, "POST /auth/register");

    const response: supertest.Response = await verifyRegistration(
        email,
        await setRegistrationCode(email)
    );

    expectStatus(response, 201, "POST /auth/register/verify");

    const cookie: string = response.headers["set-cookie"][0];

    return { id: await currentUserId(cookie), username, email, password, cookie };
};

export const createTestUser = (prefix: string = "t"): Promise<TestUser> =>
    registerTestUser(`${prefix}${randomHex(5)}`);

export const deleteTestUsers = async (filter: Record<string, unknown>): Promise<number> => {
    const users = await UserModel.find(filter).select("_id").lean();
    const ids = users.map((user) => user._id);

    await PastebinModel.deleteMany({ addedBy: { $in: ids } });
    await ShortUrlModel.deleteMany({ addedBy: { $in: ids } });
    await UserUploadsModel.deleteMany({ uploadedBy: { $in: ids } });

    for (const id of ids) {
        await fs.promises.rm(path.join(process.env.UPLOAD_DISK_DIRECTORY, id.toString()), {
            recursive: true,
            force: true
        });
    }

    await UserModel.deleteMany({ _id: { $in: ids } });

    return ids.length;
};
