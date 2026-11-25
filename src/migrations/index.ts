import { ensureIndexes } from "./009-ensure-indexes";

export type Migration = {
    name: string;
    up: () => Promise<void>;
};

export const migrations: Migration[] = [
    { name: "009-ensure-indexes", up: ensureIndexes },
    { name: "010-api-key-index", up: ensureIndexes },
    { name: "011-session-token-index", up: ensureIndexes }
];
