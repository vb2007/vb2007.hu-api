import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import { isPlainObject } from "lodash";

import { API_KEY_SCOPES } from "../constants/limits";
import { Responses } from "../constants/responses";
import { hasOneAuthorization } from "./apiKeys";

dotenv.config();

export interface OauthClient {
    id: string;
    name: string;
    secretHash: string;
    redirectUris: string[];
    scopes: string[];
    accountStatus: boolean;
}

const clientFields: string[] = [
    "id",
    "name",
    "secretHash",
    "redirectUris",
    "scopes",
    "accountStatus"
];

const namePattern: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;

const secretHashPattern: RegExp = /^[0-9a-f]{64}$/;

const reservedIds: string[] = API_KEY_SCOPES.map((scope: string): string =>
    scope.split(":")[0].toLowerCase()
);

const isListOf = (value: unknown, isValid: (item: string) => boolean): value is string[] =>
    Array.isArray(value) &&
    value.every((item: unknown): boolean => typeof item === "string" && isValid(item));

const isName = (value: string): boolean => namePattern.test(value);

const loopbackHosts: string[] = ["localhost", "127.0.0.1", "[::1]"];

const isRedirectUrl = ({ protocol, hostname }: URL): boolean =>
    protocol === "https:" || (protocol === "http:" && loopbackHosts.includes(hostname));

const isRedirectUri = (value: string): boolean =>
    URL.canParse(value) && isRedirectUrl(new URL(value)) && !value.includes("#");

const clientProblem = (client: Record<string, unknown>): string | null => {
    const { id, name, secretHash, redirectUris, scopes, accountStatus } = client;
    const unknownField: string | undefined = Object.keys(client).find(
        (field: string): boolean => !clientFields.includes(field)
    );

    if (unknownField !== undefined) {
        return `unknown field ${unknownField}: a client only has ${clientFields.join(", ")}`;
    }

    if (typeof id !== "string" || !isName(id)) {
        return "id must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit";
    }

    if (reservedIds.includes(id)) {
        return `id ${id} is taken by the API key scopes`;
    }

    if (typeof name !== "string" || name.trim() === "") {
        return "name must be a non-empty string";
    }

    if (typeof secretHash !== "string" || !secretHashPattern.test(secretHash)) {
        return "secretHash must be the client secret's SHA-256 as 64 lowercase hex digits";
    }

    if (!isListOf(redirectUris, isRedirectUri)) {
        return "redirectUris must be a list of https URLs, or http ones on localhost, 127.0.0.1 or [::1], without a fragment";
    }

    if (!isListOf(scopes, isName) || new Set(scopes).size !== scopes.length) {
        return "scopes must be a list of distinct names of 1-64 lowercase letters, digits or hyphens each";
    }

    if (accountStatus !== undefined && typeof accountStatus !== "boolean") {
        return "accountStatus must be true or false when given";
    }

    return null;
};

const parseJson = (value: string): unknown => {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error("OAUTH_CLIENTS must be valid JSON");
    }
};

export const parseOauthClients = (value: string | undefined): OauthClient[] => {
    if (!value) {
        return [];
    }

    const clients: unknown = parseJson(value);

    if (!Array.isArray(clients)) {
        throw new Error("OAUTH_CLIENTS must be a JSON array of clients");
    }

    return clients.map((client: unknown, index: number): OauthClient => {
        const problem: string | null = isPlainObject(client)
            ? clientProblem(client as Record<string, unknown>)
            : "must be an object";

        if (problem) {
            throw new Error(`OAUTH_CLIENTS[${index}]: ${problem}`);
        }

        const parsed = client as OauthClient;

        if (clients.slice(0, index).some((other: OauthClient): boolean => other.id === parsed.id)) {
            throw new Error(`OAUTH_CLIENTS[${index}]: id ${parsed.id} is used twice`);
        }

        return { ...parsed, accountStatus: parsed.accountStatus === true };
    });
};

const clients: Map<string, OauthClient> = new Map(
    parseOauthClients(process.env.OAUTH_CLIENTS).map((client: OauthClient) => [client.id, client])
);

export const findClient = (id: string): OauthClient | null => clients.get(id) ?? null;

export const hashClientSecret = (secret: string): string =>
    crypto.createHash("sha256").update(secret).digest("hex");

export const clientSecretMatches = ({ secretHash }: OauthClient, secret: string): boolean =>
    crypto.timingSafeEqual(
        Buffer.from(hashClientSecret(secret), "hex"),
        Buffer.from(secretHash, "hex")
    );

const basicPattern: RegExp = /^basic +([A-Za-z0-9+/]+={0,2})$/i;

export const clientOf = (req: express.Request): OauthClient | null => {
    const authorization: string = hasOneAuthorization(req) ? req.headers.authorization : "";
    const [, encoded] = basicPattern.exec(authorization) ?? [];
    const credentials: string = Buffer.from(encoded ?? "", "base64").toString("utf8");
    const separator: number = credentials.indexOf(":");
    const client: OauthClient | null =
        separator > 0 ? findClient(credentials.slice(0, separator)) : null;

    return client && clientSecretMatches(client, credentials.slice(separator + 1)) ? client : null;
};

export const answerRejectedClient = (res: express.Response) => {
    res.locals.clientRejected = true;
    res.set("WWW-Authenticate", 'Basic realm="vb2007.hu"');

    return res.status(401).json({ error: Responses.OAuth.invalidClient });
};

export const wasClientRejected = (res: express.Response): boolean =>
    res.locals.clientRejected === true;
