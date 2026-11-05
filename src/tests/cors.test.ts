import { parseCorsOrigins } from "../helpers/cors";

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
});
