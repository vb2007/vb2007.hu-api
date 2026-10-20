import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { MigrationsModel } from "../database/migrations";
import { UserModel } from "../database/users";
import { UserUploadsModel } from "../database/userUploads";
import { Migration } from "../migrations";
import { runMigrations } from "../migrations/runner";
import { migrateUpload } from "../migrations/001-upload-storage-layout";

const TestMigrationsModel = mongoose.model(
    "MigrationTest",
    MigrationsModel.schema,
    "migrations-test"
) as typeof MigrationsModel;

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
            const user = await UserModel.findOne({ username: TestData.username });
            userId = user._id.toString();

            const uploadDir: string = path.resolve(process.env.UPLOAD_DISK_DIRECTORY);
            legacyDir = path.join(uploadDir, TestData.username);
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
});
