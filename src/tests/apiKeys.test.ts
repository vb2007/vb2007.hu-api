import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    API_KEYS_MAX,
    API_KEY_EXPIRY_DEFAULT_DAYS,
    API_KEY_NAME_MAX_LENGTH,
    FAILED_ATTEMPTS_PER_ACCOUNT,
    GITHUB_REAUTH_MINUTES,
    SECURITY_NOTICES_PER_DAY
} from "../constants/limits";
import { emailChangeScope, passwordResetLinkScope, passwordResetScope } from "../database/users";
import { authentication } from "../helpers";
import { createEmailCode, hashEmailCode } from "../helpers/emailCodes";
import { createOauthSecret } from "../helpers/github";
import { hashApiKey } from "../helpers/apiKeys";
import { runRequestReset } from "./helpers/passwordReset";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    randomHex,
    storedAuthentication,
    storedUser,
    testEmailOf,
    updateStoredUser
} from "./helpers/testUsers";

const dayMs: number = 24 * 60 * 60 * 1000;
const tokenPattern: RegExp = /^vbk_[\w-]{43}$/;
const listItemKeys: string[] = [
    "createdAt",
    "expiresAt",
    "hint",
    "id",
    "lastUsedAt",
    "name",
    "scopes"
];

const superuser = (): TestUser => ({
    id: TestData.superuser.id,
    username: TestData.superuser.username,
    email: TestData.superuser.email,
    password: TestData.superuser.password,
    cookie: TestData.superuser.cookie
});

const createKey = (
    user: TestUser,
    body: Record<string, unknown> = {},
    clientIp: string = isolatedClientIp()
): supertest.Test =>
    request(TestData.apiURL)
        .post("/user/api-keys")
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", clientIp)
        .send({ name: "CI", scopes: ["pastes:read"], password: user.password, ...body });

const rotateKey = (
    user: TestUser,
    id: string,
    body: Record<string, unknown> = {}
): supertest.Test =>
    request(TestData.apiURL)
        .post(`/user/api-keys/${id}/rotate`)
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ password: user.password, ...body });

const deleteKey = (user: TestUser, id: string): supertest.Test =>
    request(TestData.apiURL).delete(`/user/api-keys/${id}`).set("Cookie", user.cookie);

const listKeys = async (user: TestUser) =>
    (await request(TestData.apiURL).get("/user/api-keys").set("Cookie", user.cookie).expect(200))
        .body.apiKeys;

const storedKeys = async (user: TestUser) => (await storedAuthentication(user.id)).apiKeys;

const lifetimeOf = ({ createdAt, expiresAt }: { createdAt: string; expiresAt: string }): number =>
    new Date(expiresAt).getTime() - new Date(createdAt).getTime();

const seedKeys = (user: TestUser, count: number, key: Record<string, unknown> = {}) =>
    updateStoredUser(user.id, (f) => [
        f("authentication.apiKeys").set(
            Array.from({ length: count }, () => ({
                id: randomHex(16),
                name: "seeded",
                hash: randomHex(32),
                hint: "abcd",
                scopes: ["pastes:read"],
                createdAt: new Date(),
                expiresAt: null as Date | null,
                lastUsedAt: null as Date | null,
                ...key
            }))
        )
    ]);

const githubOnlyUser = async (prefix: string, verifiedAt: Date): Promise<TestUser> => {
    const user: TestUser = await createTestUser(prefix);
    await linkGithub(user, true);
    await confirmGithub(user, verifiedAt);
    return user;
};

const staleGithubLogin = (): Date => new Date(Date.now() - (GITHUB_REAUTH_MINUTES + 1) * 60 * 1000);

describe("API key management", (): void => {
    it("should answer 403 without a session", async (): Promise<void> => {
        await request(TestData.apiURL).get("/user/api-keys").expect(403);
        await request(TestData.apiURL)
            .post("/user/api-keys")
            .send({ name: "x", scopes: ["pastes:read"] })
            .expect(403);
    });

    it("should show the token once, store only its hash and list the key without either", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akc");

        const response: supertest.Response = await createKey(user, {
            name: "  Deploy bot  ",
            scopes: ["pastes:read", "shortUrls:write"]
        }).expect(201);

        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body.message).toBe(Responses.ApiKeys.apiKeyCreatedSuccess);

        const { token, ...created } = response.body.apiKey;
        expect(token).toMatch(tokenPattern);
        expect(Object.keys(created).sort()).toEqual(listItemKeys);
        expect(created).toMatchObject({
            name: "Deploy bot",
            hint: token.slice(-4),
            scopes: ["pastes:read", "shortUrls:write"],
            lastUsedAt: null
        });
        expect(created.id).toMatch(/^[0-9a-f]{32}$/);
        expect(lifetimeOf(created)).toBe(API_KEY_EXPIRY_DEFAULT_DAYS * dayMs);

        const [stored] = await storedKeys(user);
        expect(stored.hash).toBe(hashApiKey(token));
        expect(JSON.stringify(await storedUser(user.id))).not.toContain(token.slice(4));

        const listed = await listKeys(user);
        expect(listed).toEqual([created]);
        expect(JSON.stringify(listed)).not.toContain(stored.hash);
    });

    it("should rotate a key to a new token, keeping its lifetime unless a new one is sent", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akr");
        const created = (await createKey(user, { expiresInDays: 30 }).expect(201)).body.apiKey;
        const [before] = await storedKeys(user);

        const rotated: supertest.Response = await rotateKey(user, created.id).expect(200);

        expect(rotated.headers["cache-control"]).toBe("no-store");
        expect(rotated.body.message).toBe(Responses.ApiKeys.apiKeyRotatedSuccess);
        const { token, ...listed } = rotated.body.apiKey;
        expect(token).toMatch(tokenPattern);
        expect(token).not.toBe(created.token);
        expect(listed).toMatchObject({
            id: created.id,
            name: created.name,
            scopes: created.scopes,
            hint: token.slice(-4)
        });
        expect(lifetimeOf(listed)).toBe(30 * dayMs);

        const [after] = await storedKeys(user);
        expect(after.hash).toBe(hashApiKey(token));
        expect(after.hash).not.toBe(before.hash);
        expect(listed.lastUsedAt).toBeNull();
        expect(await listKeys(user)).toEqual([listed]);

        const never = (await rotateKey(user, created.id, { expiresInDays: null }).expect(200)).body
            .apiKey;
        expect(never.expiresAt).toBeNull();

        const stillNever = (await rotateKey(user, created.id).expect(200)).body.apiKey;
        expect(stillNever.expiresAt).toBeNull();

        const week = (await rotateKey(user, created.id, { expiresInDays: 7 }).expect(200)).body
            .apiKey;
        expect(lifetimeOf(week)).toBe(7 * dayMs);
    });

    it("should start a rotated key's creation and last use over, and renew an expired key's lifetime", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akrr");
        const createdAt: Date = new Date(Date.now() - 40 * dayMs);
        await seedKeys(user, 1, {
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 30 * dayMs),
            lastUsedAt: new Date(Date.now() - dayMs)
        });
        const [seeded] = await storedKeys(user);

        const startedAt: number = Date.now();
        const rotated = (await rotateKey(user, seeded.id).expect(200)).body.apiKey;

        expect(new Date(rotated.createdAt).getTime()).toBeGreaterThanOrEqual(startedAt);
        expect(rotated.lastUsedAt).toBeNull();
        expect(lifetimeOf(rotated)).toBe(30 * dayMs);

        const [stored] = await storedKeys(user);
        expect(stored.createdAt.getTime()).toBe(new Date(rotated.createdAt).getTime());
        expect(stored).not.toHaveProperty("lastUsedAt");
    });

    it("should answer 409 to all but one of parallel rotations of a key", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akrp");
        const { id } = (await createKey(user).expect(201)).body.apiKey;

        const answers: supertest.Response[] = await Promise.all([
            rotateKey(user, id),
            rotateKey(user, id),
            rotateKey(user, id)
        ]);

        expect(answers.map(({ status }) => status).sort()).toEqual([200, 409, 409]);
        expect(
            answers.filter(({ status }) => status === 409).map(({ body }) => body.error)
        ).toEqual([Responses.ApiKeys.apiKeyChanged, Responses.ApiKeys.apiKeyChanged]);

        const winner = answers.find(({ status }) => status === 200).body.apiKey;
        expect((await storedKeys(user))[0].hash).toBe(hashApiKey(winner.token));
    });

    it("should refuse to rotate an admin-scoped key once its owner isn't the superuser", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akra");
        await seedKeys(user, 1, { scopes: ["pastes:read", "admin:write"] });
        const before = await storedKeys(user);

        expect((await rotateKey(user, before[0].id).expect(403)).body.error).toBe(
            Responses.ApiKeys.adminScopesNotAllowed
        );
        expect(await storedKeys(user)).toEqual(before);
    });

    it("should refuse to create or rotate a key once the day's security notices are used up", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akb");
        const { id } = (await createKey(user).expect(201)).body.apiKey;
        const before = await storedKeys(user);

        await updateStoredUser(user.id, (f) => [
            f("authentication.securityNotices").set({
                count: SECURITY_NOTICES_PER_DAY,
                since: new Date()
            })
        ]);

        expect((await createKey(user).expect(429)).body.error).toBe(
            Responses.ApiKeys.tooManySecurityNotices
        );
        expect((await rotateKey(user, id).expect(429)).body.error).toBe(
            Responses.ApiKeys.tooManySecurityNotices
        );
        expect(await storedKeys(user)).toEqual(before);

        await deleteKey(user, id).expect(200);
        expect(await storedKeys(user)).toEqual([]);
    });

    it("should answer 404 to rotating or deleting a key that isn't the user's", async (): Promise<void> => {
        const owner: TestUser = await createTestUser("ako");
        const other: TestUser = await createTestUser("akx");
        const { id } = (await createKey(owner).expect(201)).body.apiKey;

        for (const missing of [id, randomHex(16), "not-an-id"]) {
            expect((await rotateKey(other, missing).expect(404)).body.error).toBe(
                Responses.ApiKeys.apiKeyNotFound
            );
            expect((await deleteKey(other, missing).expect(404)).body.error).toBe(
                Responses.ApiKeys.apiKeyNotFound
            );
        }

        expect(await listKeys(owner)).toHaveLength(1);
    });

    it("should delete a key without a password", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akd");
        const kept = (await createKey(user, { name: "kept" }).expect(201)).body.apiKey;
        const { id } = (await createKey(user, { name: "gone" }).expect(201)).body.apiKey;

        expect((await deleteKey(user, id).expect(200)).body.message).toBe(
            Responses.ApiKeys.apiKeyDeletedSuccess
        );
        await deleteKey(user, id).expect(404);

        expect((await listKeys(user)).map(({ id }: { id: string }) => id)).toEqual([kept.id]);
    });

    it("should ask for the password to create or rotate a key", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akp");
        const { id } = (await createKey(user).expect(201)).body.apiKey;

        expect((await createKey(user, { password: undefined }).expect(400)).body.error).toBe(
            Responses.ApiKeys.missingPassword
        );
        expect((await rotateKey(user, id, { password: "" }).expect(400)).body.error).toBe(
            Responses.ApiKeys.missingPassword
        );
        expect((await createKey(user, { password: "wrong-password" }).expect(403)).body.error).toBe(
            Responses.Authentication.incorrectPassword
        );
        expect(
            (await rotateKey(user, id, { password: "wrong-password" }).expect(403)).body.error
        ).toBe(Responses.Authentication.incorrectPassword);

        const keys = await storedKeys(user);
        expect(keys).toHaveLength(1);
        expect((await rotateKey(user, id).expect(200)).body.apiKey.id).toBe(id);
    });

    it("should lock out the account's password checks after too many wrong passwords", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akl");

        for (let attempt = 0; attempt < FAILED_ATTEMPTS_PER_ACCOUNT; attempt++) {
            await createKey(user, { password: "wrong-password" }).expect(403);
        }

        await createKey(user).expect(429);
        expect(await storedKeys(user)).toBeUndefined();
    });

    it("should accept a recent GitHub login instead of a password on an account without one", async (): Promise<void> => {
        const user: TestUser = await githubOnlyUser("akg", staleGithubLogin());
        const githubReauthRequired: string =
            Responses.ApiKeys.githubReauthRequired(GITHUB_REAUTH_MINUTES);

        expect((await createKey(user, { password: undefined }).expect(403)).body.error).toBe(
            githubReauthRequired
        );

        await confirmGithub(user);
        const { id } = (await createKey(user, { password: undefined }).expect(201)).body.apiKey;
        await rotateKey(user, id, { password: undefined }).expect(200);

        await confirmGithub(user, staleGithubLogin());
        expect((await rotateKey(user, id, { password: undefined }).expect(403)).body.error).toBe(
            githubReauthRequired
        );
    });

    it(`should allow at most ${API_KEYS_MAX} keys, also for parallel requests`, async (): Promise<void> => {
        const user: TestUser = await createTestUser("akm");
        await seedKeys(user, API_KEYS_MAX - 1);

        const statuses: number[] = (
            await Promise.all([createKey(user), createKey(user), createKey(user)])
        ).map(({ status }) => status);

        expect(statuses.sort()).toEqual([201, 409, 409]);
        expect(await storedKeys(user)).toHaveLength(API_KEYS_MAX);
        expect((await createKey(user).expect(409)).body.error).toBe(
            Responses.ApiKeys.tooManyApiKeys
        );
    });

    test.each([
        ["no name", { name: undefined }, Responses.ApiKeys.missingName],
        ["a blank name", { name: "   " }, Responses.ApiKeys.missingName],
        ["a numeric name", { name: 5 }, Responses.ApiKeys.missingName],
        [
            "a too long name",
            { name: "a".repeat(API_KEY_NAME_MAX_LENGTH + 1) },
            Responses.ApiKeys.nameTooLong
        ],
        ["a name with a line break", { name: "a\nb" }, Responses.ApiKeys.nameInvalidCharacters],
        ["no scopes", { scopes: undefined }, Responses.ApiKeys.invalidScopes],
        ["empty scopes", { scopes: [] }, Responses.ApiKeys.invalidScopes],
        ["a scope string", { scopes: "pastes:read" }, Responses.ApiKeys.invalidScopes],
        ["an unknown scope", { scopes: ["pastes:delete"] }, Responses.ApiKeys.invalidScopes],
        [
            "a duplicate scope",
            { scopes: ["pastes:read", "pastes:read"] },
            Responses.ApiKeys.invalidScopes
        ],
        ["a zero day expiry", { expiresInDays: 0 }, Responses.ApiKeys.invalidExpiry],
        ["a 366 day expiry", { expiresInDays: 366 }, Responses.ApiKeys.invalidExpiry],
        ["a fractional expiry", { expiresInDays: 1.5 }, Responses.ApiKeys.invalidExpiry],
        ["a string expiry", { expiresInDays: "30" }, Responses.ApiKeys.invalidExpiry]
    ])(
        "should answer 400 to %s",
        async (_: string, body: Record<string, unknown>, error: string): Promise<void> => {
            const user: TestUser = await createTestUser("akv");

            expect((await createKey(user, body).expect(400)).body.error).toBe(error);
            expect(await storedKeys(user)).toBeUndefined();
        }
    );

    it("should answer 400 to rotating with an out-of-range expiry", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akre");
        const { id } = (await createKey(user).expect(201)).body.apiKey;

        for (const expiresInDays of [0, 366, "7"]) {
            expect((await rotateKey(user, id, { expiresInDays }).expect(400)).body.error).toBe(
                Responses.ApiKeys.invalidExpiry
            );
        }
    });

    it("should accept a key that never expires and the longest expiry", async (): Promise<void> => {
        const user: TestUser = await createTestUser("akn");

        expect(
            (await createKey(user, { expiresInDays: null }).expect(201)).body.apiKey.expiresAt
        ).toBeNull();
        expect(
            lifetimeOf((await createKey(user, { expiresInDays: 365 }).expect(201)).body.apiKey)
        ).toBe(365 * dayMs);

        const [never] = await storedKeys(user);
        expect(never).not.toHaveProperty("expiresAt");
    });

    it("should give admin scopes only to the superuser's keys", async (): Promise<void> => {
        const user: TestUser = await createTestUser("aka");

        for (const scopes of [["admin:read"], ["pastes:read", "admin:write"]]) {
            expect((await createKey(user, { scopes }).expect(403)).body.error).toBe(
                Responses.ApiKeys.adminScopesNotAllowed
            );
        }
        expect(await storedKeys(user)).toBeUndefined();

        const { id, scopes } = (
            await createKey(superuser(), { scopes: ["admin:read", "admin:write"] }).expect(201)
        ).body.apiKey;
        expect(scopes).toEqual(["admin:read", "admin:write"]);

        await deleteKey(superuser(), id).expect(200);
    });

    describe("lifecycle", (): void => {
        const userWithKey = async (prefix: string): Promise<TestUser> => {
            const user: TestUser = await createTestUser(prefix);
            await createKey(user).expect(201);
            return user;
        };

        it("should drop the keys on a password reset with a code", async (): Promise<void> => {
            const user: TestUser = await userWithKey("aklc");
            await runRequestReset(user.email);
            const code: string = createEmailCode();
            await updateStoredUser(user.id, (f) => [
                f("authentication.passwordReset.hash").set(
                    hashEmailCode(passwordResetScope(user.id, user.email), code)
                )
            ]);

            await request(TestData.apiURL)
                .post("/auth/password-reset/confirm")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email: user.email, code, newPassword: randomHex(12) })
                .expect(200);

            expect(await storedKeys(user)).toBeUndefined();
        });

        it("should drop the keys on a password reset with a link", async (): Promise<void> => {
            const user: TestUser = await userWithKey("akll");
            const secret: string = createOauthSecret();
            await updateStoredUser(user.id, (f) => [
                f("authentication.passwordResetLinks").push({
                    hash: authentication(passwordResetLinkScope(user.id), secret),
                    expiresAt: new Date(Date.now() + 30 * 60 * 1000)
                })
            ]);

            await request(TestData.apiURL)
                .post("/auth/password-reset/confirm-link")
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ token: `${user.id}.${secret}`, newPassword: randomHex(12) })
                .expect(200);

            expect(await storedKeys(user)).toBeUndefined();
        });

        it("should drop the keys when the account is suspended", async (): Promise<void> => {
            const user: TestUser = await userWithKey("akls");

            await request(TestData.apiURL)
                .patch(`/admin/users/${user.id}/suspension`)
                .set("Cookie", TestData.superuser.cookie)
                .send({ suspended: true })
                .expect(200);

            expect(await storedKeys(user)).toBeUndefined();
        });

        it("should drop the keys when the admin resets the account's MFA", async (): Promise<void> => {
            const user: TestUser = await userWithKey("aklm");

            await request(TestData.apiURL)
                .delete(`/admin/users/${user.id}/mfa`)
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);

            expect(await storedKeys(user)).toBeUndefined();
        });

        it("should keep the keys on an e-mail change", async (): Promise<void> => {
            const user: TestUser = await userWithKey("akle");
            const email: string = testEmailOf(`akle${randomHex(5)}`);

            await request(TestData.apiURL)
                .patch("/user/email")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ email, password: user.password })
                .expect(202);
            const code: string = createEmailCode();
            await updateStoredUser(user.id, (f) => [
                f("authentication.emailChange.hash").set(
                    hashEmailCode(emailChangeScope(user.id, email), code)
                )
            ]);
            await request(TestData.apiURL)
                .post("/user/email/confirm")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ code })
                .expect(200);

            expect((await storedUser(user.id)).email).toBe(email);
            expect(await storedKeys(user)).toHaveLength(1);
        });

        it("should keep the keys on a password change", async (): Promise<void> => {
            const user: TestUser = await userWithKey("aklp");

            await request(TestData.apiURL)
                .patch("/user/password")
                .set("Cookie", user.cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send({ currentPassword: user.password, newPassword: randomHex(12) })
                .expect(200);

            expect(await storedKeys(user)).toHaveLength(1);
        });
    });
});
