import request, { Response } from "supertest";
import { TestData } from "../constants/testData";
import { randomHex, registerTestUser, testEmailOf } from "./helpers/testUsers";

describe("Admin user list sorted by username", (): void => {
    const prefix: string = `o${randomHex(3)}`;
    const ordered: string[] = ["_x", "1", "a", "á", "B", "ß", "st", "z"].map(
        (suffix: string): string => `${prefix}${suffix}`
    );

    const listUsernames = async (query: Record<string, string>): Promise<string[]> => {
        const response: Response = await request(TestData.apiURL)
            .get("/admin/users")
            .query({ q: prefix, sortBy: "username", ...query })
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);

        return response.body.users.map(({ username }: { username: string }): string => username);
    };

    beforeAll(async (): Promise<void> => {
        for (const [index, username] of [...ordered].reverse().entries()) {
            await registerTestUser(username, testEmailOf(`${prefix}${index}`));
        }
    });

    it("should keep the case-insensitive, accent-aware collation order", async (): Promise<void> => {
        expect(await listUsernames({ sortOrder: "asc" })).toEqual(ordered);
        expect(await listUsernames({ sortOrder: "desc" })).toEqual([...ordered].reverse());
    });

    it("should page through the collation order", async (): Promise<void> => {
        expect(await listUsernames({ sortOrder: "asc", limit: "3", page: "2" })).toEqual(
            ordered.slice(3, 6)
        );
    });
});
