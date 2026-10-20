import { MigrationsModel } from "../database/migrations";
import type { Migration } from "./index";

export const runMigrations = async (
    migrations: Migration[],
    model: typeof MigrationsModel = MigrationsModel
): Promise<void> => {
    const appliedNames: string[] = await model.distinct("name");
    const pendingMigrations: Migration[] = migrations.filter(
        ({ name }) => !appliedNames.includes(name)
    );

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

        await model.create({ name });
        console.log(`Applied ${name}`);
    }
};
