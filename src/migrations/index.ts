import { migrateUploads } from "./001-upload-storage-layout";
import { normalizeUserEmails } from "./002-normalize-user-emails";
import { makeUsernamesCaseInsensitive } from "./003-case-insensitive-usernames";

export type Migration = {
    name: string;
    up: () => Promise<void>;
};

export const migrations: Migration[] = [
    { name: "001-upload-storage-layout", up: migrateUploads },
    { name: "002-normalize-user-emails", up: normalizeUserEmails },
    { name: "003-case-insensitive-usernames", up: makeUsernamesCaseInsensitive }
];
