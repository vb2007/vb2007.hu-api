import "./helpers/cryptoKey";
import { db } from "./prisma/db";
import { migrations } from "./migrations";
import { runMigrations } from "./migrations/runner";

runMigrations(migrations)
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.close());
