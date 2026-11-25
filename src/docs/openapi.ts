import fs from "fs";
import path from "path";
import { merge } from "lodash";

import { badRequest, codeFailuresWindow, components, serverError } from "./components";
import { Responses } from "../constants/responses";
import {
    JSON_BODY_MAX_BYTES,
    PIPELINED_REQUESTS_MAX,
    SECURITY_NOTICES_PER_DAY
} from "../constants/limits";
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
import * as sharex from "./paths/sharex";

export interface DocsModule {
    paths: Record<string, object>;
    components?: Record<string, Record<string, object>>;
    tags?: { name: string; description?: string }[];
}

export interface Spec extends Required<DocsModule> {
    openapi: string;
    info: { title: string; version: string; description: string };
}

const { version } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")
) as { version: string };

const commonAnswers: string[] = [
    "`OPTIONS` on any path answers the CORS preflight with `204`.",
    `A JSON body (\`Content-Type: application/json\`) is read on every route, also on those that take none: invalid JSON, or JSON that isn't an object or an array, answers \`400\` \`${Responses.invalidJson}\`, and one over ${JSON_BODY_MAX_BYTES / 1024} KiB answers \`413\` \`${Responses.requestTooLarge}\`.`,
    "Such a body in a charset other than UTF-8 or UTF-16, or with a `Content-Encoding` other than `gzip`, `deflate` or `identity`, answers `415` with the parser's message, e.g. `unsupported charset \"UTF-32\"` or `unsupported content encoding \"br\"`. One that doesn't decompress answers `400` with zlib's message, e.g. `incorrect header check` for a `gzip` body that isn't gzip.",
    `A route with a path parameter answers \`400\` \`${badRequest}\` when the parameter has a malformed percent-encoding.`,
    `At most ${PIPELINED_REQUESTS_MAX} pipelined requests wait behind the one being answered: the next one gets \`429\` \`${Responses.tooManyPipelinedRequests}\` with \`Connection: close\`, and the ones after it get no answer.`,
    `An unexpected error answers \`500\` \`${Responses.internalServerError}\`.`,
    `An unknown route or method answers \`404\` \`${Responses.routeNotFound}\`, or redirects to the site's \`/apierror?url=<path>\` page, without the query string, when the client prefers HTML.`,
    "An operation's rate limits send `RateLimit` and `RateLimit-Policy` headers (IETF draft 8) on its own answers, one pair per limiter, except the per-address limits the operations say send none. The API key limit, and its pair, only apply to requests with an `Authorization` header. The body, path and pipelining answers above come before the limiters and carry none.",
    `Security notices about account changes are mailed at most ${SECURITY_NOTICES_PER_DAY} times per account in ${codeFailuresWindow}. Past that they're dropped without an error, except that creating or rotating an API key then answers \`429\`.`
];

export const root: DocsModule = {
    tags: [{ name: "General", description: "The API itself." }],
    components,
    paths: {
        "/": {
            get: {
                tags: ["General"],
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
                    },
                    "500": serverError
                }
            }
        },
        "/healthz": {
            get: {
                tags: ["General"],
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
                    },
                    "500": serverError
                }
            }
        }
    }
};

const publicModules: Record<string, DocsModule> = {
    authentication,
    mfa,
    passkeys,
    mfaRecovery,
    users,
    apiKeys,
    shortenUrls,
    pastebin,
    userUploads,
    sharex
};

export const docsModules: Record<string, DocsModule> = { ...publicModules, admin };

const compose = (modules: DocsModule[]): Spec => ({
    openapi: "3.1.0",
    info: {
        title: "vb2007.hu API",
        version,
        description:
            'The API behind [vb2007.hu](https://vb2007.hu): accounts, short URLs, pastes and file uploads. Errors answer `{ "error": string }` with the messages listed per operation.\n\n## Common answers\n\nAny operation can also give these, which the operations don\'t all list:\n\n' +
            commonAnswers.map((answer: string): string => `- ${answer}`).join("\n")
    },
    tags: [root, ...modules].flatMap(({ tags }: DocsModule) => tags ?? []),
    paths: merge({}, ...[root, ...modules].map(({ paths }: DocsModule) => paths)),
    components: merge({}, ...[root, ...modules].map((module: DocsModule) => module.components))
});

export const publicSpec: Spec = compose(Object.values(publicModules));

export const adminSpec: Spec = compose(Object.values(docsModules));
