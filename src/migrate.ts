import mongoose from "mongoose";
import dotenv from "dotenv";

import { migrations } from "./migrations";
import { runMigrations } from "./migrations/runner";

dotenv.config();

const migrate = async (): Promise<void> => {
    await mongoose.connect(process.env.DB_CONNECTION_STRING);
    await runMigrations(migrations);
};

migrate()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
