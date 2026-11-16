import request from "supertest";
import supertest from "supertest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { MongoFieldFilter, MongoFilterExpr } from "@prisma/orm-mongo/query-ast";
import type {
    FieldAccessor,
    ModelNestedShape,
    ModelToDocShape,
    UpdaterResult
} from "@prisma/orm-mongo/query-builder";
import { TestData } from "../../constants/testData";
import { db } from "../../prisma/db";
import type { Contract } from "../../prisma/contract.d";
import { User, UserFields, getUserById, updateUser } from "../../database/users";
import { registrationCodeScope } from "../../database/pendingRegistrations";
import { countOf, firstOf, idIs, objectIdParam, runQuery } from "../../helpers/prisma";
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

export const storedUser = (id: string): Promise<User | null> => getUserById(id);

export const updateStoredUser = (id: string, update: (f: UserFields) => UpdaterResult) =>
    updateUser(idIs(id), update);

export const storedAuthentication = async (id: string) => (await storedUser(id)).authentication;

type PendingRegistrationFields = FieldAccessor<
    ModelToDocShape<Contract, "PendingRegistration">,
    ModelNestedShape<Contract, "PendingRegistration">
>;

export const pendingRegistrationOf = (email: string) =>
    db.orm.pendingregistrations.where({ email }).first();

export const updatePendingRegistration = (
    email: string,
    update: (f: PendingRegistrationFields) => UpdaterResult
) =>
    firstOf(
        db.query
            .from("pendingregistrations")
            .match(MongoFieldFilter.eq("email", email))
            .updateOne(update)
    );

export const isolatedClientIp = (): string => `2001:db8:${randomHex(2)}:${randomHex(1)}00::1`;

export const registerRequest = (
    body: Record<string, unknown>,
    clientIp: string = isolatedClientIp()
): supertest.Test =>
    request(TestData.apiURL).post("/auth/register").set("X-Forwarded-For", clientIp).send(body);

export const setRegistrationCode = async (email: string): Promise<string> => {
    const normalizedEmail: string = normalizeEmail(email);
    const code: string = createEmailCode();

    await updatePendingRegistration(normalizedEmail, (f) => [
        f("code.hash").set(hashEmailCode(registrationCodeScope(normalizedEmail), code))
    ]);

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

    await updateStoredUser(sessionUser.id, (f) => [
        f("authentication.sessionToken").set(hashSessionToken(sessionToken)),
        f("authentication.sessionExpiresAt").set(expiresAt)
    ]);

    return `${sessionCookie}=${sessionToken}`;
};

export const linkGithub = async (
    linkedUser: TestUser,
    withoutPassword: boolean = false
): Promise<string> => {
    const githubId: string = `${TestData.runId}-${randomHex(8)}`;

    await updateStoredUser(linkedUser.id, (f) => [
        f.githubId.set(githubId),
        f.githubLogin.set(`gh-${randomHex(5)}`),
        ...(withoutPassword
            ? [f("authentication.password").unset(), f("authentication.salt").unset()]
            : [])
    ]);

    return githubId;
};

export const confirmGithub = async (
    githubUser: TestUser,
    verifiedAt: Date = new Date()
): Promise<void> => {
    await updateStoredUser(githubUser.id, (f) => [
        f("authentication.githubVerifiedAt").set(verifiedAt)
    ]);
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

export const countOwnedContent = async (userId: string) => ({
    pastes: await countOf(
        db.query
            .from("pastebins")
            .match((f) => f.addedBy.eq(objectIdParam(userId)))
            .count("n")
            .build()
    ),
    shortUrls: await countOf(
        db.query
            .from("shorturls")
            .match((f) => f.addedBy.eq(objectIdParam(userId)))
            .count("n")
            .build()
    ),
    uploads: await countOf(
        db.query
            .from("useruploads")
            .match((f) => f.uploadedBy.eq(objectIdParam(userId)))
            .count("n")
            .build()
    )
});

export const deleteTestUsers = async (filter: MongoFilterExpr): Promise<number> => {
    const users = await runQuery(db.query.from("users").match(filter).project("_id").build());
    const hexIds: string[] = users.map(({ _id }): string => String(_id));

    await db.orm.pastebins.where(MongoFieldFilter.in("addedBy", hexIds)).deleteAndCount();
    await db.orm.shorturls.where(MongoFieldFilter.in("addedBy", hexIds)).deleteAndCount();
    await db.orm.useruploads.where(MongoFieldFilter.in("uploadedBy", hexIds)).deleteAndCount();

    for (const id of hexIds) {
        await fs.promises.rm(path.join(process.env.UPLOAD_DISK_DIRECTORY, id), {
            recursive: true,
            force: true
        });
    }

    await db.orm.users.where(MongoFieldFilter.in("id", hexIds)).deleteAndCount();

    return hexIds.length;
};
