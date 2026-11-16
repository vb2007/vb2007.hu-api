import mongoose from "mongoose";
import dotenv from "dotenv";
import { db } from "../../prisma/db";

dotenv.config();

beforeAll(async (): Promise<void> => {
    await mongoose.connect(process.env.DB_CONNECTION_STRING, {
        autoCreate: false,
        autoIndex: false
    });
});

afterAll(async (): Promise<void> => {
    await mongoose.disconnect();
    await db.close();
});
