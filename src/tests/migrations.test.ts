import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { MigrationsModel } from "../database/migrations";
import { UserModel, usernameCollation } from "../database/users";
import { UserUploadsModel } from "../database/userUploads";
import { Migration } from "../migrations";
import { runMigrations } from "../migrations/runner";
import { migrateUpload } from "../migrations/001-upload-storage-layout";
import { normalizeUserEmails } from "../migrations/002-normalize-user-emails";
import { makeUsernamesCaseInsensitive } from "../migrations/003-case-insensitive-usernames";
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

const removeDirIfEmpty = async (dir: string): Promise<void> => {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        await fs.promises.rmdir(dir);
    }
};

const appliedNames = async (): Promise<string[]> =>
    (await TestMigrationsModel.find().sort({ appliedOn: 1, _id: 1 })).map(({ name }) => name);

describe("Migrations Tests", (): void => {
    beforeAll(async (): Promise<void> => {
        await mongoose.connect(process.env.DB_CONNECTION_STRING, {
            autoCreate: false,
            autoIndex: false
        });
    });

    afterAll(async (): Promise<void> => {
        await TestMigrationsModel.collection.drop().catch((): void => undefined);
        await TestUsersModel.collection.drop().catch((): void => undefined);
        await mongoose.disconnect();
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
            await expect(insertUsers([username.toUpperCase()])).rejects.toHaveProperty(
                "code",
                11000
            );
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
});
