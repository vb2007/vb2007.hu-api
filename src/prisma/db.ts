import dotenv from "dotenv";
import mongo from "@prisma/orm-mongo/runtime";
import { contractFromJson } from "@prisma/orm-mongo/static";
import type { Contract } from "./contract.d";
import contractJson from "./contract.json";

dotenv.config();

export const contract = contractFromJson<Contract>(contractJson);

export const withServerSelectionTimeout = (url: string, timeoutMs: number): string =>
    /[?&]serverSelectionTimeoutMS=/i.test(url)
        ? url
        : `${url}${url.includes("?") ? "&" : "?"}serverSelectionTimeoutMS=${timeoutMs}`;

export const db = mongo({
    contract,
    url: withServerSelectionTimeout(process.env.DB_CONNECTION_STRING, 2000)
});
