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
import { hashSessionToken, normalizeEmail } from "../../helpers";
import { sessionCookie } from "../../helpers/session";
import { SESSION_MAX_AGE_MS } from "../../constants/limits";

export interface TestUser {
    id: string;
    username: string;
    email: string;
    password: string;
    cookie: string;
}

export const randomHex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex");

export const randomHan = (length: number): string =>
    Array.from({ length }, (): string =>
        String.fromCharCode(0x4e00 + crypto.randomInt(0x4000))
    ).join("");

export const emojiTags = (text: string): string =>
    [...text]
        .map((character: string): string => String.fromCodePoint(0xe0000 + character.charCodeAt(0)))
        .join("");

export const subdivisionFlag = (code: string): string => `\u{1F3F4}${emojiTags(code)}\u{E007F}`;

export const scryptHashPattern: RegExp = /^scrypt\$16384\$8\$5\$[0-9a-f]{128}$/;

export const expectHostOnlySessionCookie = (setCookie: string): void => {
    const [nameValue, ...attributes] = setCookie.split("; ");

    expect(nameValue.startsWith(`${sessionCookie}=`)).toBe(true);
    expect(attributes).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "Secure"]));
    expect(attributes).not.toContainEqual(expect.stringMatching(/^Domain=/i));
};

export const clearedSessionCookieOf = (response: supertest.Response): string =>
    []
        .concat(response.headers["set-cookie"] ?? [])
        .find((setCookie: string): boolean => setCookie.startsWith(`${sessionCookie}=;`));

export const unsignedUrl = (url: string): string => url.split("?")[0];

export const signedUrlPattern = (url: string): RegExp =>
    new RegExp(
        `^${unsignedUrl(url).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?expires=(\\d+)&sig=[\\w-]{43}$`
    );

export const sameUpload = (upload: any): any => ({
    ...upload,
    url:
        upload.visibility === "public"
            ? upload.url
            : expect.stringMatching(signedUrlPattern(upload.url))
});

export const storedAuthentication = async (id: string) =>
    (await UserModel.findById(id).select("+authentication.salt +authentication.password").lean())
        .authentication;

export const isolatedClientIp = (): string => `2001:db8:${randomHex(2)}:${randomHex(1)}00::1`;

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

export const verifyRequest = (body: Record<string, unknown>): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/register/verify")
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

export const verifyRegistration = (
    email: string,
    code: string,
    username: string = `v${randomHex(5)}`,
    password: string = randomHex(12)
): supertest.Test => verifyRequest({ email, code, username, password });

export const testEmailOf = (username: string, domain: string = TestData.emailDomain): string =>
    `${username.toLowerCase()}@${domain}`;

const longTestEmailDomain: string = `${"a".repeat(63)}.`.repeat(3) + TestData.emailDomain;

export const testEmailOfLength = (length: number): string =>
    testEmailOf(
        randomHex(5).padEnd(length - longTestEmailDomain.length - 1, "a"),
        longTestEmailDomain
    );

const expectStatus = (response: supertest.Response, status: number, action: string): void => {
    if (response.status !== status) {
        throw new Error(`${action} answered ${response.status}: ${response.text}`);
    }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const emailsEndingWith = (suffix: string): RegExp =>
    new RegExp(`${escapeRegExp(suffix)}$`, "i");

export const emailsOnOrUnder = (domain: string): RegExp =>
    new RegExp(`[@.]${escapeRegExp(domain)}$`, "i");

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
        await setRegistrationCode(email),
        username,
        password
    );

    expectStatus(response, 201, "POST /auth/register/verify");

    const cookie: string = response.headers["set-cookie"][0];

    return { id: await currentUserId(cookie), username, email, password, cookie };
};

export const createTestUser = (prefix: string = "t"): Promise<TestUser> =>
    registerTestUser(`${prefix}${randomHex(5)}`);

export const sessionTokenOf = (cookie: string): string =>
    decodeURIComponent(cookie.split(";")[0].split("=")[1]);

export const storeSession = async (
    sessionUser: TestUser,
    expiresAt: Date = new Date(Date.now() + SESSION_MAX_AGE_MS)
): Promise<string> => {
    const sessionToken: string = randomHex(32);

    await UserModel.updateOne(
        { _id: sessionUser.id },
        {
            $set: {
                "authentication.sessionToken": hashSessionToken(sessionToken),
                "authentication.sessionExpiresAt": expiresAt
            }
        }
    );

    return `${sessionCookie}=${sessionToken}`;
};

export const linkGithub = async (
    linkedUser: TestUser,
    withoutPassword: boolean = false
): Promise<string> => {
    const githubId: string = `${TestData.runId}-${randomHex(8)}`;

    await UserModel.updateOne(
        { _id: linkedUser.id },
        {
            $set: { githubId, githubLogin: `gh-${randomHex(5)}` },
            ...(withoutPassword && {
                $unset: { "authentication.password": 1, "authentication.salt": 1 }
            })
        }
    );

    return githubId;
};

export const confirmGithub = async (
    githubUser: TestUser,
    verifiedAt: Date = new Date()
): Promise<void> => {
    await UserModel.updateOne(
        { _id: githubUser.id },
        { $set: { "authentication.githubVerifiedAt": verifiedAt } }
    );
};

export const addPasteAndShortUrl = async (cookie: string): Promise<void> => {
    expectStatus(
        await request(TestData.apiURL)
            .post("/paste")
            .set("Cookie", cookie)
            .send({ paste: `paste ${randomHex(8)}` }),
        201,
        "POST /paste"
    );

    expectStatus(
        await request(TestData.apiURL)
            .post("/shortenUrl")
            .set("Cookie", cookie)
            .send({ url: `https://${TestData.runId}-${randomHex(8)}.vb2007.test/` }),
        201,
        "POST /shortenUrl"
    );
};

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
