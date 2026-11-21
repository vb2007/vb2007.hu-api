import { MongoFieldFilter } from "@prisma/orm-mongo/query-ast";
import { CreateIndexCommand, DropCollectionCommand } from "@prisma/orm-mongo/query-ast/control";
import { TestData, runCollectionName, runCollectionPattern } from "../constants/testData";
import { db } from "../prisma/db";
import { withControl } from "../prisma/control";
import { Migration } from "../migrations";
import { runMigrations } from "../migrations/runner";
import { ensureIndexes, indexCommands } from "../migrations/009-ensure-indexes";

const runName = (name: string): string => `test-${TestData.runId}-${name}`;

const runCollectionsCreatedAt: Date = new Date();

const runCollection = (name: string): string => runCollectionName(name, runCollectionsCreatedAt);

const runCollections: string[] = [
    ...new Set(indexCommands(runCollection).map(({ collection }) => collection))
];

const dropRunCollections = (): Promise<void> =>
    withControl(async ({ run, listCollectionNames }): Promise<void> => {
        const existing: string[] = await listCollectionNames();

        for (const name of runCollections.filter((name) => existing.includes(name))) {
            await run(new DropCollectionCommand(name));
        }
    });

const indexesOf = (collection: string): Promise<Record<string, unknown>[]> =>
    withControl(({ listIndexes }) => listIndexes(runCollection(collection)));

const indexNamesOf = async (collection: string): Promise<string[]> =>
    (await indexesOf(collection)).map(({ name }) => String(name)).sort();

describe("Migrations Tests", (): void => {
    describe("runMigrations", (): void => {
        let runOrder: string[];

        const migrationNamed = (name: string): Migration => ({
            name: runName(name),
            up: async (): Promise<void> => {
                runOrder.push(name);
            }
        });

        const failingMigration: Migration = {
            name: runName("003-fails"),
            up: async (): Promise<void> => {
                runOrder.push("003-fails");
                throw new Error("Migration failed");
            }
        };

        const runNames: string[] = ["001-first", "002-second", "003-fails", "004-after"].map(
            runName
        );

        const appliedNames = async (): Promise<string[]> =>
            (
                await db.orm.migrations
                    .where(MongoFieldFilter.in("name", runNames))
                    .orderBy({ appliedOn: 1, id: 1 })
                    .all()
            ).map(({ name }) => name);

        const deleteRunRecords = (): Promise<number> =>
            db.orm.migrations.where(MongoFieldFilter.in("name", runNames)).deleteAndCount();

        beforeEach(async (): Promise<void> => {
            runOrder = [];
            await deleteRunRecords();
        });

        afterAll(async (): Promise<void> => {
            await deleteRunRecords();
        });

        it("should run pending migrations in order and record them", async (): Promise<void> => {
            await runMigrations([migrationNamed("001-first"), migrationNamed("002-second")]);

            expect(runOrder).toEqual(["001-first", "002-second"]);
            expect(await appliedNames()).toEqual([runName("001-first"), runName("002-second")]);
        });

        it("should skip migrations that are already applied", async (): Promise<void> => {
            await db.orm.migrations.create({ name: runName("001-first"), appliedOn: new Date() });

            await runMigrations([migrationNamed("001-first"), migrationNamed("002-second")]);

            expect(runOrder).toEqual(["002-second"]);
            expect(await appliedNames()).toEqual([runName("001-first"), runName("002-second")]);
        });

        it("should not record a failed migration and stop the ones after it", async (): Promise<void> => {
            await expect(
                runMigrations([
                    migrationNamed("001-first"),
                    failingMigration,
                    migrationNamed("004-after")
                ])
            ).rejects.toThrow("Migration failed");

            expect(runOrder).toEqual(["001-first", "003-fails"]);
            expect(await appliedNames()).toEqual([runName("001-first")]);
        });

        it("should do nothing on a second run", async (): Promise<void> => {
            const migrations: Migration[] = [migrationNamed("001-first")];
            const logSpy: jest.SpyInstance = jest.spyOn(console, "log");

            await runMigrations(migrations);
            runOrder = [];
            logSpy.mockClear();

            await runMigrations(migrations);

            expect(runOrder).toEqual([]);
            expect(logSpy).toHaveBeenCalledWith("No pending migrations");
            expect(await appliedNames()).toEqual([runName("001-first")]);

            logSpy.mockRestore();
        });
    });

    describe("009-ensure-indexes ensureIndexes", (): void => {
        beforeEach(dropRunCollections);
        afterAll(dropRunCollections);

        it("should name its collections so the stale run sweep finds them", (): void => {
            expect(runCollections.filter((name) => !runCollectionPattern.test(name))).toEqual([]);
        });

        it("should create every index on fresh collections", async (): Promise<void> => {
            await ensureIndexes(runCollection);

            expect(await indexNamesOf("users")).toEqual(
                [
                    "_id_",
                    "authentication.apiKeys.hash_1",
                    "authentication.passkeys.credentialId_1",
                    "email_1",
                    "githubId_1",
                    "username_1"
                ].sort()
            );
            expect(await indexNamesOf("pastebins")).toEqual(
                ["_id_", "addedBy_1_addedOn_-1__id_-1", "addedOn_-1__id_-1"].sort()
            );
            expect(await indexNamesOf("shorturls")).toEqual(
                [
                    "_id_",
                    "shortenedUrl_1",
                    "originalUrl_1_addedBy_1",
                    "addedBy_1_addedOn_-1__id_-1",
                    "addedOn_-1__id_-1"
                ].sort()
            );
            expect(await indexNamesOf("useruploads")).toEqual(
                [
                    "_id_",
                    "visibility_1",
                    "uploadedBy_1_uploadedOn_-1__id_-1",
                    "uploadedOn_-1__id_-1"
                ].sort()
            );
            expect(await indexNamesOf("pendingregistrations")).toEqual(
                ["_id_", "email_1", "expiresAt_1"].sort()
            );
            expect(await indexNamesOf("passkeychallenges")).toEqual(["_id_", "expiresAt_1"]);
            expect(await indexNamesOf("migrations")).toEqual(["_id_", "name_1"]);

            const users: Record<string, unknown>[] = await indexesOf("users");
            const userIndex = (name: string): Record<string, unknown> | undefined =>
                users.find((index) => index.name === name);

            expect(userIndex("email_1")).toMatchObject({ key: { email: 1 }, unique: true });
            expect(userIndex("githubId_1")).toMatchObject({ unique: true, sparse: true });
            expect(userIndex("username_1")).toMatchObject({
                unique: true,
                collation: { locale: "en", strength: 2 }
            });
            expect(userIndex("authentication.passkeys.credentialId_1")).toMatchObject({
                unique: true,
                partialFilterExpression: {
                    "authentication.passkeys.credentialId": { $exists: true }
                }
            });
            expect(userIndex("authentication.apiKeys.hash_1")).toMatchObject({
                key: { "authentication.apiKeys.hash": 1 },
                unique: true,
                partialFilterExpression: { "authentication.apiKeys.hash": { $exists: true } }
            });
            expect(await indexesOf("shorturls")).toContainEqual(
                expect.objectContaining({
                    name: "addedBy_1_addedOn_-1__id_-1",
                    key: { addedBy: 1, addedOn: -1, _id: -1 }
                })
            );
            expect(await indexesOf("pendingregistrations")).toContainEqual(
                expect.objectContaining({ name: "expiresAt_1", expireAfterSeconds: 0 })
            );
        });

        it("should change nothing on a second run", async (): Promise<void> => {
            await ensureIndexes(runCollection);
            const before: Record<string, unknown>[][] = await Promise.all(
                runCollections.map((name) => withControl(({ listIndexes }) => listIndexes(name)))
            );

            await ensureIndexes(runCollection);

            expect(
                await Promise.all(
                    runCollections.map((name) =>
                        withControl(({ listIndexes }) => listIndexes(name))
                    )
                )
            ).toEqual(before);
        });

        it("should fail on an index of the same name with other options and keep it", async (): Promise<void> => {
            await withControl(({ run }) =>
                run(
                    new CreateIndexCommand(
                        runCollection("users"),
                        [{ field: "email", direction: 1 }],
                        {
                            name: "email_1"
                        }
                    )
                )
            );

            await expect(ensureIndexes(runCollection)).rejects.toMatchObject({
                codeName: "IndexKeySpecsConflict"
            });

            expect(
                (await indexesOf("users")).find(({ name }) => name === "email_1")
            ).not.toHaveProperty("unique");
        });
    });
});
