import crypto from "crypto";

import { OAUTH_PARAM_MAX_LENGTH } from "../constants/limits";
import { OauthClient, findClient } from "./oauthClients";

export const authorizeParams: string[] = [
    "response_type",
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "nonce"
];

const codeChallengePattern: RegExp = /^[A-Za-z0-9_-]{43}$/;

const codeVerifierPattern: RegExp = /^[A-Za-z0-9._~-]{43,128}$/;

export const isParam = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 1 && value.length <= OAUTH_PARAM_MAX_LENGTH;

export const authorizeTargetOf = ({
    client_id,
    redirect_uri
}: Record<string, unknown>):
    | { client: OauthClient; redirectUri: string }
    | { error: "invalid_client" | "invalid_redirect_uri" } => {
    const client: OauthClient | null = typeof client_id === "string" ? findClient(client_id) : null;

    if (!client) {
        return { error: "invalid_client" };
    }

    return typeof redirect_uri === "string" && client.redirectUris.includes(redirect_uri)
        ? { client, redirectUri: redirect_uri }
        : { error: "invalid_redirect_uri" };
};

export const authorizeRequestError = ({
    response_type,
    state,
    code_challenge,
    code_challenge_method,
    nonce
}: Record<string, unknown>): "unsupported_response_type" | "invalid_request" | null => {
    if (typeof response_type === "string" && response_type !== "code") {
        return "unsupported_response_type";
    }

    return response_type === "code" &&
        code_challenge_method === "S256" &&
        typeof code_challenge === "string" &&
        codeChallengePattern.test(code_challenge) &&
        isParam(state) &&
        isParam(nonce)
        ? null
        : "invalid_request";
};

export const withQuery = (uri: string, params: Record<string, string>): string =>
    `${uri}${uri.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`;

export const verifierMatches = (codeChallenge: string, codeVerifier: string): boolean => {
    const expected: Buffer = Buffer.from(
        crypto.createHash("sha256").update(codeVerifier).digest("base64url")
    );
    const challenge: Buffer = Buffer.from(codeChallenge);

    return (
        codeVerifierPattern.test(codeVerifier) &&
        challenge.length === expected.length &&
        crypto.timingSafeEqual(challenge, expected)
    );
};
