import dotenv from "dotenv";
import { db } from "../../prisma/db";

dotenv.config();

afterAll(async (): Promise<void> => {
    await db.close();
});
