import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { MigrationsModel } from "../database/migrations";
import { UserModel, usernameCollation } from "../database/users";
import { UserUploadsModel } from "../database/userUploads";
import { ShortUrlModel } from "../database/shortUrls";
import { Migration } from "../migrations";
import { runMigrations } from "../migrations/runner";
import { migrateUpload } from "../migrations/001-upload-storage-layout";
import { normalizeUserEmails } from "../migrations/002-normalize-user-emails";
import { makeUsernamesCaseInsensitive } from "../migrations/003-case-insensitive-usernames";
import { makeShortUrlsPerUser } from "../migrations/004-per-user-short-urls";
import { clearPlaintextSessionTokens } from "../migrations/005-clear-plaintext-session-tokens";
import { endSharedDomainSessions } from "../migrations/006-end-shared-domain-sessions";
import { wrapLegacyPasswordHashes } from "../migrations/007-wrap-legacy-password-hashes";
import { authentication, hashSessionToken, random } from "../helpers";
import { hashPassword, verifyPassword } from "../helpers/password";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";

const TestMigrationsModel = mongoose.model(
    "MigrationTest",
    MigrationsModel.schema,
    `migrations-test-${TestData.runId}`
) as typeof MigrationsModel;

const TestUsersModel = mongoose.model(
    "UserTest",
    UserModel.schema,
    `users-test-${TestData.runId}`
) as typeof UserModel;

const TestShortUrlsModel = mongoose.model(
    "ShortUrlTest",
    ShortUrlModel.schema,
    `shorturls-test-${TestData.runId}`
) as typeof ShortUrlModel;

const removeDirIfEmpty = async (dir: string): Promise<void> => {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        await fs.promises.rmdir(dir);
    }
};

const appliedNames = async (): Promise<string[]> =>
    (await TestMigrationsModel.find().sort({ appliedOn: 1, _id: 1 })).map(({ name }) => name);

describe("Migrations Tests", (): void => {
    afterAll(async (): Promise<void> => {
        await TestMigrationsModel.collection.drop().catch((): void => undefined);
        await TestUsersModel.collection.drop().catch((): void => undefined);
        await TestShortUrlsModel.collection.drop().catch((): void => undefined);
    });

    describe("runMigrations", (): void => {
        let runOrder: string[];

        const migrationNamed = (name: string): Migration => ({
            name,
            up: async (): Promise<void> => {
                runOrder.push(name);
            }
        });

        const failingMigration: Migration = {
            name: "003-fails",
            up: async (): Promise<void> => {
                runOrder.push("003-fails");
                throw new Error("Migration failed");
            }
        };

        beforeEach(async (): Promise<void> => {
            runOrder = [];
            await TestMigrationsModel.deleteMany({});
        });

        it("should run pending migrations in order and record them", async (): Promise<void> => {
            await runMigrations(
                [migrationNamed("001-first"), migrationNamed("002-second")],
                TestMigrationsModel
            );

            expect(runOrder).toEqual(["001-first", "002-second"]);
            expect(await appliedNames()).toEqual(["001-first", "002-second"]);
        });

        it("should skip migrations that are already applied", async (): Promise<void> => {
            await TestMigrationsModel.create({ name: "001-first" });

            await runMigrations(
                [migrationNamed("001-first"), migrationNamed("002-second")],
                TestMigrationsModel
            );

            expect(runOrder).toEqual(["002-second"]);
            expect(await appliedNames()).toEqual(["001-first", "002-second"]);
        });

        it("should not record a failed migration and stop the ones after it", async (): Promise<void> => {
            await expect(
                runMigrations(
                    [migrationNamed("001-first"), failingMigration, migrationNamed("004-after")],
                    TestMigrationsModel
                )
            ).rejects.toThrow("Migration failed");

            expect(runOrder).toEqual(["001-first", "003-fails"]);
            expect(await appliedNames()).toEqual(["001-first"]);
        });

        it("should do nothing on a second run", async (): Promise<void> => {
            const migrations: Migration[] = [migrationNamed("001-first")];
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await runMigrations(migrations, TestMigrationsModel);
            runOrder = [];
            logSpy.mockClear();

            await runMigrations(migrations, TestMigrationsModel);

            expect(runOrder).toEqual([]);
            expect(logSpy).toHaveBeenCalledWith("No pending migrations");
            expect(await appliedNames()).toEqual(["001-first"]);

            logSpy.mockRestore();
        });
    });

    describe("001-upload-storage-layout migrateUpload", (): void => {
        const uploadId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
        const legacyStoredFileName: string = `1700000000000-${uploadId}.png`;
        const uploadedOn: Date = new Date("2025-01-01T00:00:00.000Z");
        const fileContent: Buffer = Buffer.from("legacy upload");
        let userId: string;
        let legacyDir: string;
        let legacyFilePath: string;
        let migratedFilePath: string;

        const findLegacyRecord = () => UserUploadsModel.collection.findOne({ _id: uploadId });

        beforeAll(async (): Promise<void> => {
            const user: TestUser = await createTestUser();
            userId = user.id;

            const uploadDir: string = path.resolve(process.env.UPLOAD_DISK_DIRECTORY);
            legacyDir = path.join(uploadDir, user.username);
            legacyFilePath = path.join(legacyDir, legacyStoredFileName);
            migratedFilePath = path.join(uploadDir, userId, `${uploadId}.png`);

            await fs.promises.mkdir(legacyDir, { recursive: true });
            await fs.promises.writeFile(legacyFilePath, fileContent);

            await UserUploadsModel.collection.insertOne({
                _id: uploadId,
                originalFileName: "Legacy.PNG",
                storedFileName: legacyStoredFileName,
                filePath: legacyFilePath,
                fileSize: fileContent.length,
                mimeType: "image/png",
                uploadedBy: new mongoose.Types.ObjectId(userId),
                uploadedOn
            });
        });

        afterAll(async (): Promise<void> => {
            await UserUploadsModel.collection.deleteOne({ _id: uploadId });
            await fs.promises.rm(legacyFilePath, { force: true });
            await fs.promises.rm(migratedFilePath, { force: true });
            await removeDirIfEmpty(legacyDir);
            await removeDirIfEmpty(path.dirname(migratedFilePath));
        });

        it("should move the file to <userId>/<uploadId><ext> and update the record", async (): Promise<void> => {
            expect(await migrateUpload((await findLegacyRecord()) as any)).toBe("migrated");

            expect(fs.existsSync(legacyFilePath)).toBe(false);
            expect(fs.readFileSync(migratedFilePath)).toEqual(fileContent);

            const record = await findLegacyRecord();

            expect(record.storedFileName).toBe(`${uploadId}.png`);
            expect(record.filePath).toBe(migratedFilePath);
            expect(record.extension).toBe(".png");
            expect(record.updatedOn).toEqual(uploadedOn);
        });

        it("should leave an already migrated upload unchanged", async (): Promise<void> => {
            expect(await migrateUpload((await findLegacyRecord()) as any)).toBe("unchanged");
            expect(fs.readFileSync(migratedFilePath)).toEqual(fileContent);
        });
    });

    describe("002-normalize-user-emails normalizeUserEmails", (): void => {
        const emailOf = (local: string): string => `${local}@${TestData.emailDomain.toLowerCase()}`;

        const insertUsers = async (emails: string[]): Promise<mongoose.Types.ObjectId[]> => {
            const { insertedIds } = await TestUsersModel.collection.insertMany(
                emails.map((email: string) => ({ username: `t${randomHex(5)}`, email }))
            );

            return Object.values(insertedIds);
        };

        const storedEmails = async (): Promise<string[]> =>
            (await TestUsersModel.find().sort({ _id: 1 }).lean()).map(({ email }) => email);

        beforeEach(async (): Promise<void> => {
            await TestUsersModel.deleteMany({});
        });

        it("should lower-case e-mails and leave normalized ones alone", async (): Promise<void> => {
            await insertUsers([emailOf("Mixed.Case"), emailOf("lower")]);

            await normalizeUserEmails(TestUsersModel);
            await normalizeUserEmails(TestUsersModel);

            expect(await storedEmails()).toEqual([emailOf("mixed.case"), emailOf("lower")]);
        });

        it("should stop on case-only duplicates, listing their ids and changing nothing", async (): Promise<void> => {
            const emails: string[] = [emailOf("Dup"), emailOf("dup"), emailOf("Other")];
            const [firstId, secondId] = await insertUsers(emails);

            const migration: Promise<void> = normalizeUserEmails(TestUsersModel);

            await expect(migration).rejects.toThrow(`${firstId}, ${secondId}`);
            await expect(migration).rejects.toHaveProperty(
                "message",
                expect.not.stringMatching(/dup@|other@/i)
            );
            expect(await storedEmails()).toEqual(emails);
        });
    });

    describe("003-case-insensitive-usernames makeUsernamesCaseInsensitive", (): void => {
        const insertUsers = async (usernames: string[]): Promise<mongoose.Types.ObjectId[]> => {
            const { insertedIds } = await TestUsersModel.collection.insertMany(
                usernames.map((username: string) => ({
                    username,
                    email: testEmailOf(`t${randomHex(5)}`)
                }))
            );

            return Object.values(insertedIds);
        };

        const usernameIndex = async () =>
            (await TestUsersModel.collection.indexes()).find(({ name }) => name === "username_1");

        beforeEach(async (): Promise<void> => {
            await TestUsersModel.collection.drop().catch((): void => undefined);
            await TestUsersModel.collection.createIndex({ username: 1 }, { unique: true });
        });

        it("should stop on case-only clashes, listing their ids and keeping the old index", async (): Promise<void> => {
            const username: string = `t${randomHex(5)}`;
            const [firstId, secondId] = await insertUsers([
                username,
                username.toUpperCase(),
                `t${randomHex(5)}`
            ]);

            const migration: Promise<void> = makeUsernamesCaseInsensitive(TestUsersModel);

            await expect(migration).rejects.toThrow(`${firstId}, ${secondId}`);
            await expect(migration).rejects.toHaveProperty(
                "message",
                expect.not.stringMatching(new RegExp(username, "i"))
            );
            expect(await usernameIndex()).not.toHaveProperty("collation");
        });

        it("should replace the username index with a case-insensitive unique one", async (): Promise<void> => {
            const username: string = `t${randomHex(5)}`;
            await insertUsers([username]);

            await makeUsernamesCaseInsensitive(TestUsersModel);
            await makeUsernamesCaseInsensitive(TestUsersModel);

            expect(await usernameIndex()).toMatchObject({
                unique: true,
                collation: usernameCollation
            });
            await expect(
                TestUsersModel.create({
                    username: username.toUpperCase(),
                    email: testEmailOf(`t${randomHex(5)}`)
                })
            ).rejects.toMatchObject({
                code: 11000,
                keyPattern: { username: 1 }
            });
            await TestUsersModel.createIndexes();
        });

        it("should restore the old index when the new one can't be created", async (): Promise<void> => {
            await insertUsers([`t${randomHex(5)}`]);
            const createIndexSpy: jest.SpyInstance = jest
                .spyOn(TestUsersModel.collection, "createIndex")
                .mockRejectedValueOnce(new Error("Index build failed"));

            await expect(makeUsernamesCaseInsensitive(TestUsersModel)).rejects.toThrow(
                "Index build failed"
            );
            createIndexSpy.mockRestore();

            expect(await usernameIndex()).toMatchObject({ unique: true });
            expect(await usernameIndex()).not.toHaveProperty("collation");
        });
    });

    describe("004-per-user-short-urls makeShortUrlsPerUser", (): void => {
        const originalUrl: string = `https://${TestData.runId}-${randomHex(8)}.vb2007.test/`;

        const insertShortUrl = (addedBy: mongoose.Types.ObjectId) =>
            TestShortUrlsModel.collection.insertOne({
                originalUrl,
                shortenedUrl: randomHex(4),
                addedBy
            });

        const indexNames = async (): Promise<string[]> =>
            (await TestShortUrlsModel.collection.indexes()).map(({ name }) => name);

        beforeAll(async (): Promise<void> => {
            await TestShortUrlsModel.collection.drop().catch((): void => undefined);
            await TestShortUrlsModel.collection.createIndex({ originalUrl: 1 }, { unique: true });
            await insertShortUrl(new mongoose.Types.ObjectId());
        });

        it("should replace the global originalUrl index with a per-user unique one", async (): Promise<void> => {
            await makeShortUrlsPerUser(TestShortUrlsModel);

            expect(await indexNames()).not.toContain("originalUrl_1");
            expect(
                (await TestShortUrlsModel.collection.indexes()).find(
                    ({ name }) => name === "originalUrl_1_addedBy_1"
                )
            ).toMatchObject({ key: { originalUrl: 1, addedBy: 1 }, unique: true });

            const userId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
            await insertShortUrl(userId);
            await expect(insertShortUrl(userId)).rejects.toMatchObject({
                code: 11000,
                keyPattern: { originalUrl: 1, addedBy: 1 }
            });
        });

        it("should do nothing on a second run", async (): Promise<void> => {
            const indexesBefore: string[] = await indexNames();
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await makeShortUrlsPerUser(TestShortUrlsModel);

            expect(logSpy).toHaveBeenCalledWith("Short URLs already unique per user");
            expect(await indexNames()).toEqual(indexesBefore);

            logSpy.mockRestore();
        });
    });

    describe("005-clear-plaintext-session-tokens clearPlaintextSessionTokens", (): void => {
        const insertUser = async (
            authentication: Record<string, unknown>
        ): Promise<mongoose.Types.ObjectId> =>
            (
                await TestUsersModel.collection.insertOne({
                    username: `t${randomHex(5)}`,
                    email: testEmailOf(`t${randomHex(5)}`),
                    authentication
                })
            ).insertedId;

        const storedAuthenticationOf = async (id: mongoose.Types.ObjectId) =>
            (await TestUsersModel.collection.findOne({ _id: id })).authentication;

        beforeEach(async (): Promise<void> => {
            await TestUsersModel.deleteMany({});
        });

        it("should clear plain-text tokens and keep hashed, expiring sessions", async (): Promise<void> => {
            const password: string = randomHex(16);
            const hashedSession = {
                sessionToken: hashSessionToken(randomHex(32)),
                sessionExpiresAt: new Date(Date.now() + 60 * 1000)
            };
            const [plaintextId, hashedId, loggedOutId] = await Promise.all([
                insertUser({ password, sessionToken: randomHex(32) }),
                insertUser({ password, ...hashedSession }),
                insertUser({ password })
            ]);

            await clearPlaintextSessionTokens(TestUsersModel);
            await clearPlaintextSessionTokens(TestUsersModel);

            expect(await storedAuthenticationOf(plaintextId)).toEqual({ password });
            expect(await storedAuthenticationOf(hashedId)).toEqual({ password, ...hashedSession });
            expect(await storedAuthenticationOf(loggedOutId)).toEqual({ password });
        });

        it("should log how many tokens it cleared, and none on a second run", async (): Promise<void> => {
            await insertUser({ sessionToken: randomHex(32) });
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await clearPlaintextSessionTokens(TestUsersModel);
            await clearPlaintextSessionTokens(TestUsersModel);

            expect(logSpy.mock.calls).toEqual([
                ["Plain-text session tokens cleared: 1"],
                ["Plain-text session tokens cleared: 0"]
            ]);

            logSpy.mockRestore();
        });
    });

    describe("006-end-shared-domain-sessions endSharedDomainSessions", (): void => {
        const insertUser = async (
            authentication: Record<string, unknown>
        ): Promise<mongoose.Types.ObjectId> =>
            (
                await TestUsersModel.collection.insertOne({
                    username: `s${randomHex(5)}`,
                    email: testEmailOf(`s${randomHex(5)}`),
                    authentication
                })
            ).insertedId;

        const storedAuthenticationOf = async (id: mongoose.Types.ObjectId) =>
            (await TestUsersModel.collection.findOne({ _id: id })).authentication;

        it("should end every session and keep the rest of the authentication", async (): Promise<void> => {
            const password: string = randomHex(16);
            const [hashedId, plaintextId, expiryOnlyId, loggedOutId] = await Promise.all([
                insertUser({
                    password,
                    sessionToken: hashSessionToken(randomHex(32)),
                    sessionExpiresAt: new Date(Date.now() + 60 * 1000)
                }),
                insertUser({ password, sessionToken: randomHex(32) }),
                insertUser({ password, sessionExpiresAt: new Date() }),
                insertUser({ password })
            ]);

            await endSharedDomainSessions(TestUsersModel);
            await endSharedDomainSessions(TestUsersModel);

            for (const id of [hashedId, plaintextId, expiryOnlyId, loggedOutId]) {
                expect(await storedAuthenticationOf(id)).toEqual({ password });
            }
        });

        it("should log how many sessions it ended, and none on a second run", async (): Promise<void> => {
            await Promise.all([
                insertUser({
                    sessionToken: hashSessionToken(randomHex(32)),
                    sessionExpiresAt: new Date()
                }),
                insertUser({
                    sessionToken: hashSessionToken(randomHex(32)),
                    sessionExpiresAt: new Date()
                })
            ]);
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await endSharedDomainSessions(TestUsersModel);
            await endSharedDomainSessions(TestUsersModel);

            expect(logSpy.mock.calls).toEqual([
                ["Shared-domain sessions ended: 2"],
                ["Shared-domain sessions ended: 0"]
            ]);

            logSpy.mockRestore();
        });
    });

    describe("007-wrap-legacy-password-hashes wrapLegacyPasswordHashes", (): void => {
        const password: string = randomHex(16);

        const insertUser = async (
            userAuthentication?: Record<string, unknown>
        ): Promise<mongoose.Types.ObjectId> =>
            (
                await TestUsersModel.collection.insertOne({
                    username: `p${randomHex(5)}`,
                    email: testEmailOf(`p${randomHex(5)}`),
                    ...(userAuthentication && { authentication: userAuthentication })
                })
            ).insertedId;

        const insertLegacyUser = async (): Promise<[mongoose.Types.ObjectId, string]> => {
            const salt: string = random();

            return [await insertUser({ salt, password: authentication(salt, password) }), salt];
        };

        const storedAuthenticationOf = async (id: mongoose.Types.ObjectId) =>
            (await TestUsersModel.collection.findOne({ _id: id })).authentication;

        beforeEach(async (): Promise<void> => {
            await TestUsersModel.deleteMany({});
        });

        it("should wrap legacy hashes into the scrypt hash of the same password", async (): Promise<void> => {
            const [id, salt] = await insertLegacyUser();

            await wrapLegacyPasswordHashes(TestUsersModel);

            const stored = await storedAuthenticationOf(id);

            expect(stored).toEqual({ salt, password: await hashPassword(salt, password) });
            await expect(verifyPassword(salt, stored.password, password)).resolves.toBe(true);
            await expect(verifyPassword(salt, stored.password, `${password}!`)).resolves.toBe(
                false
            );
        });

        it("should leave scrypt hashes, hashes without a salt and accounts without a password alone", async (): Promise<void> => {
            const salt: string = random();
            const scryptAuthentication = { salt, password: await hashPassword(salt, password) };
            const unsaltedAuthentication = { password: authentication(salt, password) };
            const emptyAuthentication = { salt, password: "" };
            const githubAuthentication = { githubVerifiedAt: new Date() };
            const [scryptId, unsaltedId, emptyId, githubId, noAuthenticationId] = await Promise.all(
                [
                    insertUser(scryptAuthentication),
                    insertUser(unsaltedAuthentication),
                    insertUser(emptyAuthentication),
                    insertUser(githubAuthentication),
                    insertUser()
                ]
            );

            await wrapLegacyPasswordHashes(TestUsersModel);

            expect(await storedAuthenticationOf(scryptId)).toEqual(scryptAuthentication);
            expect(await storedAuthenticationOf(unsaltedId)).toEqual(unsaltedAuthentication);
            expect(await storedAuthenticationOf(emptyId)).toEqual(emptyAuthentication);
            expect(await storedAuthenticationOf(githubId)).toEqual(githubAuthentication);
            expect(await storedAuthenticationOf(noAuthenticationId)).toBeUndefined();
        });

        it("should log how many hashes it wrapped, and change nothing on a second run", async (): Promise<void> => {
            const [id] = await insertLegacyUser();
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await wrapLegacyPasswordHashes(TestUsersModel);
            const wrapped = await storedAuthenticationOf(id);
            await wrapLegacyPasswordHashes(TestUsersModel);

            expect(logSpy.mock.calls).toEqual([
                ["Legacy password hashes wrapped: 1, skipped: 0"],
                ["Legacy password hashes wrapped: 0, skipped: 0"]
            ]);
            expect(await storedAuthenticationOf(id)).toEqual(wrapped);

            logSpy.mockRestore();
        });

        const expectSkippedWhenChangedDuringRun = async (
            id: mongoose.Types.ObjectId,
            changedAuthentication: Record<string, unknown>
        ): Promise<void> => {
            const updateOne = TestUsersModel.updateOne.bind(TestUsersModel);
            const updateOneSpy: jest.SpyInstance = jest
                .spyOn(TestUsersModel as any, "updateOne")
                .mockImplementationOnce(async (...args: any[]): Promise<any> => {
                    await TestUsersModel.collection.updateOne(
                        { _id: id },
                        { $set: { authentication: changedAuthentication } }
                    );

                    return updateOne(...args);
                });
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await wrapLegacyPasswordHashes(TestUsersModel);
            updateOneSpy.mockRestore();

            expect(logSpy.mock.calls).toEqual([["Legacy password hashes wrapped: 0, skipped: 1"]]);
            expect(await storedAuthenticationOf(id)).toEqual(changedAuthentication);

            logSpy.mockRestore();
        };

        it("should skip a hash that changed while it ran", async (): Promise<void> => {
            const [id] = await insertLegacyUser();
            const newSalt: string = random();

            await expectSkippedWhenChangedDuringRun(id, {
                salt: newSalt,
                password: await hashPassword(newSalt, password)
            });
        });

        it("should skip a hash whose salt changed while it ran", async (): Promise<void> => {
            const [id] = await insertLegacyUser();
            const { password: legacyHash } = await storedAuthenticationOf(id);

            await expectSkippedWhenChangedDuringRun(id, { salt: random(), password: legacyHash });
        });
    });
});
