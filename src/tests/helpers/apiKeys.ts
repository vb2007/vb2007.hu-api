import { apiKeyHintOf, createApiKeyId, createApiKeyToken, hashApiKey } from "../../helpers/apiKeys";
import { storedAuthentication, updateStoredUser } from "./testUsers";

export interface SeededKey {
    id: string;
    token: string;
}

export const seedKey = async (
    userId: string,
    scopes: string[],
    fields: Record<string, unknown> = {}
): Promise<SeededKey> => {
    const token: string = createApiKeyToken();
    const id: string = createApiKeyId();

    await updateStoredUser(userId, (f) => [
        f("authentication.apiKeys").push({
            id,
            name: "auth test",
            hash: hashApiKey(token),
            hint: apiKeyHintOf(token),
            scopes,
            createdAt: new Date(),
            expiresAt: null,
            lastUsedAt: null,
            ...fields
        })
    ]);

    return { id, token };
};

export const lastUsedAtOf = async (userId: string, apiKeyId: string): Promise<Date | undefined> =>
    (await storedAuthentication(userId)).apiKeys.find(({ id }) => id === apiKeyId)?.lastUsedAt;

export const waitForLastUse = async (
    userId: string,
    apiKeyId: string,
    after: Date
): Promise<Date> => {
    for (let attempt: number = 0; attempt < 50; attempt++) {
        const lastUsedAt: Date | undefined = await lastUsedAtOf(userId, apiKeyId);

        if (lastUsedAt && lastUsedAt > after) {
            return lastUsedAt;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("lastUsedAt was never set");
};
