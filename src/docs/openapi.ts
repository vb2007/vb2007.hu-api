import fs from "fs";
import path from "path";
import { merge } from "lodash";

import { components } from "./components";
import * as authentication from "./paths/authentication";
import * as users from "./paths/users";
import * as shortenUrls from "./paths/shortenUrls";
import * as pastebin from "./paths/pastebin";
import * as userUploads from "./paths/userUploads";
import * as admin from "./paths/admin";
import * as mfa from "./paths/mfa";
import * as passkeys from "./paths/passkeys";
import * as mfaRecovery from "./paths/mfaRecovery";
import * as apiKeys from "./paths/apiKeys";

export interface DocsModule {
    pending?: boolean;
    paths: Record<string, object>;
    components?: Record<string, Record<string, object>>;
    tags?: { name: string; description?: string }[];
}

export interface Spec extends Required<Omit<DocsModule, "pending">> {
    openapi: string;
    info: { title: string; version: string; description: string };
}

const { version } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")
) as { version: string };

export const root: DocsModule = {
    tags: [{ name: "general", description: "The API itself." }],
    components,
    paths: {
        "/": {
            get: {
                tags: ["general"],
                summary: "Go to the site",
                description: "Redirects to the site the API belongs to.",
                security: [],
                responses: {
                    "302": {
                        description: "Redirect to the site.",
                        headers: {
                            Location: {
                                description: "The site's URL.",
                                schema: { type: "string", format: "uri" }
                            }
                        },
                        content: {
                            "text/plain": {
                                schema: { type: "string" },
                                example: "Found. Redirecting to https://vb2007.hu"
                            },
                            "text/html": {
                                schema: { type: "string" },
                                example: "<p>Found. Redirecting to https://vb2007.hu</p>"
                            }
                        }
                    }
                }
            }
        },
        "/healthz": {
            get: {
                tags: ["general"],
                summary: "Check health",
                description:
                    "Checks that the API is up and can reach its database. Used by the container's health check.",
                security: [],
                responses: {
                    "200": {
                        description: "The API is up and the database is reachable.",
                        content: { "text/plain": { schema: { type: "string", const: "OK" } } }
                    },
                    "503": {
                        description: "The database can't be reached.",
                        content: {
                            "text/plain": {
                                schema: { type: "string", const: "Service Unavailable" }
                            }
                        }
                    }
                }
            }
        }
    }
};

const publicModules: Record<string, DocsModule> = {
    authentication,
    users,
    shortenUrls,
    pastebin,
    userUploads,
    mfa,
    passkeys,
    mfaRecovery,
    apiKeys
};

export const docsModules: Record<string, DocsModule> = { ...publicModules, admin };

const compose = (modules: DocsModule[]): Spec => ({
    openapi: "3.1.0",
    info: {
        title: "vb2007.hu API",
        version,
        description:
            'The API behind [vb2007.hu](https://vb2007.hu): accounts, short URLs, pastes and file uploads. Errors answer `{ "error": string }` with the messages listed per operation.'
    },
    tags: [root, ...modules].flatMap(({ tags }: DocsModule) => tags ?? []),
    paths: merge({}, ...[root, ...modules].map(({ paths }: DocsModule) => paths)),
    components: merge({}, ...[root, ...modules].map((module: DocsModule) => module.components))
});

export const publicSpec: Spec = compose(Object.values(publicModules));

export const adminSpec: Spec = compose(Object.values(docsModules));
