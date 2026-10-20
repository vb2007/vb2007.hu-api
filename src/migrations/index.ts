export type Migration = {
    name: string;
    up: () => Promise<void>;
};

export const migrations: Migration[] = [];
