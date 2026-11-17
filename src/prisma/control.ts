import controlDriver from "@prisma/orm-mongo/driver/control";
import {
    MongoControlAdapterImpl,
    MongoInspectionExecutor
} from "@prisma/orm-mongo/adapter/control";
import {
    AnyMongoDdlCommand,
    ListCollectionsCommand,
    ListIndexesCommand
} from "@prisma/orm-mongo/query-ast/control";

export type Control = {
    run: (command: AnyMongoDdlCommand) => Promise<void>;
    listIndexes: (collection: string) => Promise<Record<string, unknown>[]>;
    listCollectionNames: () => Promise<string[]>;
};

export const withControl = async <Result>(
    work: (control: Control) => Promise<Result>
): Promise<Result> => {
    const driver = await controlDriver.create(process.env.DB_CONNECTION_STRING);
    const adapter = new MongoControlAdapterImpl();
    const inspection = new MongoInspectionExecutor(driver.db);

    try {
        return await work({
            run: (command) => adapter.executeDdl(driver, command),
            listIndexes: (collection) => inspection.listIndexes(new ListIndexesCommand(collection)),
            listCollectionNames: async () =>
                (await inspection.listCollections(new ListCollectionsCommand())).map(
                    ({ name }) => name
                )
        });
    } finally {
        await driver.close();
    }
};
