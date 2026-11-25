import request from "supertest";
import supertest from "supertest";
import { parseCorsOrigins } from "../helpers/cors";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";

describe("CORS Origin Tests", (): void => {
    test.each([
        ["a single origin", "https://a.test", ["https://a.test"]],
        [
            "a comma separated list",
            "https://a.test,https://b.test",
            ["https://a.test", "https://b.test"]
        ],
        [
            "spaces around the entries",
            "  https://a.test , https://b.test  ",
            ["https://a.test", "https://b.test"]
        ],
        [
            "trailing and duplicate commas",
            "https://a.test,,https://b.test,",
            ["https://a.test", "https://b.test"]
        ]
    ])("should parse %s", (_: string, value: string, origins: string[]): void => {
        expect(parseCorsOrigins(value)).toEqual(origins);
    });

    test.each([
        ["unset", undefined],
        ["empty", ""],
        ["whitespace only", "   "],
        ["only commas and whitespace", " , ,, "]
    ])("should refuse a value that is %s", (_: string, value: string | undefined): void => {
        expect(() => parseCorsOrigins(value)).toThrow(
            /CORS_ORIGIN_URLS is missing or empty.*docs\/dotenv-setup\.md/
        );
    });

    describe("Origin check", (): void => {
        const foreignOrigin: string = "https://evil.example";
        const logout = (): supertest.Test => request(TestData.apiURL).post("/auth/logout");

        it("should refuse an unsafe request from a foreign origin", async (): Promise<void> => {
            const response: supertest.Response = await logout()
                .set("Origin", foreignOrigin)
                .expect(403);

            expect(response.body).toEqual({ error: Responses.foreignOrigin });
        });

        it("should refuse an unsafe request from an opaque origin", async (): Promise<void> => {
            await logout().set("Origin", "null").expect(403);
        });

        it("should pass an allowed CORS origin", async (): Promise<void> => {
            const [origin] = parseCorsOrigins(process.env.CORS_ORIGIN_URLS);
            await logout().set("Origin", origin).expect(200);
        });

        it("should pass the API's own origin", async (): Promise<void> => {
            await logout().set("Origin", new URL(TestData.apiURL).origin).expect(200);
        });

        it("should pass a request without an origin", async (): Promise<void> => {
            await logout().expect(200);
        });

        it("should leave a request with an Authorization header to its route", async (): Promise<void> => {
            const response: supertest.Response = await logout()
                .set("Origin", foreignOrigin)
                .set("Authorization", "Bearer vbk_invalid");

            expect(response.body).not.toEqual({ error: Responses.foreignOrigin });
        });

        it("should pass a safe request from a foreign origin", async (): Promise<void> => {
            await request(TestData.apiURL).get("/healthz").set("Origin", foreignOrigin).expect(200);
        });
    });
});
