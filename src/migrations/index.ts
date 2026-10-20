import { migrateUploads } from "./001-upload-storage-layout";

export type Migration = {
    name: string;
    up: () => Promise<void>;
};

export const migrations: Migration[] = [{ name: "001-upload-storage-layout", up: migrateUploads }];
