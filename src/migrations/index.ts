import { migrateUploads } from "./001-upload-storage-layout";
import { normalizeUserEmails } from "./002-normalize-user-emails";
import { makeUsernamesCaseInsensitive } from "./003-case-insensitive-usernames";
import { makeShortUrlsPerUser } from "./004-per-user-short-urls";
import { clearPlaintextSessionTokens } from "./005-clear-plaintext-session-tokens";
import { endSharedDomainSessions } from "./006-end-shared-domain-sessions";

export type Migration = {
    name: string;
    up: () => Promise<void>;
};

export const migrations: Migration[] = [
    { name: "001-upload-storage-layout", up: migrateUploads },
    { name: "002-normalize-user-emails", up: normalizeUserEmails },
    { name: "003-case-insensitive-usernames", up: makeUsernamesCaseInsensitive },
    { name: "004-per-user-short-urls", up: makeShortUrlsPerUser },
    { name: "005-clear-plaintext-session-tokens", up: clearPlaintextSessionTokens },
    { name: "006-end-shared-domain-sessions", up: endSharedDomainSessions }
];
