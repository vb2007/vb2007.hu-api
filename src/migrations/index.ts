import { ensureIndexes } from "./009-ensure-indexes";

export type Migration = {
    name: string;
    up: () => Promise<void>;
};

export const migrations: Migration[] = [{ name: "009-ensure-indexes", up: ensureIndexes }];
