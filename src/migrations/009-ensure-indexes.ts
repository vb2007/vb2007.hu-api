import { CreateIndexCommand } from "@prisma/orm-mongo/query-ast/control";

import { contract } from "../prisma/db";
import { withControl } from "../prisma/control";

export const indexCommands = (
    collectionName: (name: string) => string = (name) => name
): CreateIndexCommand[] => [
    ...Object.entries(contract.storage.namespaces.__unbound__.entries.collection).flatMap(
        ([name, { indexes }]) =>
            indexes.map(
                ({ keys, kind, ...options }) =>
                    new CreateIndexCommand(collectionName(name), keys, options)
            )
    ),
    // shortcut: PSL can't index a path into a composite type yet, move this to contract.prisma once it can.
    new CreateIndexCommand(
        collectionName("users"),
        [{ field: "authentication.passkeys.credentialId", direction: 1 }],
        {
            name: "authentication.passkeys.credentialId_1",
            unique: true,
            partialFilterExpression: { "authentication.passkeys.credentialId": { $exists: true } }
        }
    )
];

export const ensureIndexes = (collectionName?: (name: string) => string): Promise<void> =>
    withControl(async ({ run }): Promise<void> => {
        for (const command of indexCommands(collectionName)) {
            await run(command);
        }
    });
