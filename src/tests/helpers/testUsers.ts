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

export interface TestUser {
    id: string;
    username: string;
    email: string;
    password: string;
    cookie: string;
}

export const randomHex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex");

export const testEmailOf = (username: string, domain: string = TestData.emailDomain): string =>
    `${username.toLowerCase()}@${domain}`;

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

    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/register")
        .send({ username, email, password });

    expectStatus(response, 201, "POST /auth/register");

    const cookie: string = await login(email, password);

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
