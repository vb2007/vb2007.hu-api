import { findClient } from "../../helpers/oauthClients";

export const oauthTestClientSecret: string = process.env.OAUTH_TEST_CLIENT_SECRET ?? "";

const isOauthConfigured: boolean =
    oauthTestClientSecret !== "" &&
    ["ci-app", "ci-other", "ci-limits"].every((id: string): boolean => findClient(id) !== null);

export const describeWithOauthClients: jest.Describe = isOauthConfigured ? describe : describe.skip;

export const basicAuthorization = (id: string, secret: string = oauthTestClientSecret): string =>
    `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
