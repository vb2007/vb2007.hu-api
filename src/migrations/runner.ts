import { db } from "../prisma/db";
import type { Migration } from "./index";

export const runMigrations = async (migrations: Migration[]): Promise<void> => {
    const appliedNames: Set<string> = new Set(
        (await db.orm.migrations.select("name").all()).map(({ name }) => name)
    );
    const pendingMigrations: Migration[] = migrations.filter(({ name }) => !appliedNames.has(name));

    if (pendingMigrations.length === 0) {
        console.log("No pending migrations");
        return;
    }

    for (const { name, up } of pendingMigrations) {
        try {
            await up();
        } catch (error) {
            console.error(`Failed ${name}`);
            throw error;
        }

        await db.orm.migrations.create({ name, appliedOn: new Date() });
        console.log(`Applied ${name}`);
    }
};
