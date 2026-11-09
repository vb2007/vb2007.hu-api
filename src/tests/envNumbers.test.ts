import { MAX_SAFE_MEGABYTES } from "../constants/limits";
import { parsePositiveInteger } from "../helpers";

jest.mock("dotenv", () => ({
    __esModule: true,
    default: { config: (): void => undefined }
}));

const loadWithEnv = <T>(env: Record<string, string | undefined>, modulePath: string): T => {
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    let loaded: T;
    jest.isolateModules((): void => {
        loaded = require(modulePath);
    });

    return loaded;
};

const invalidValues: (string | undefined)[] = [
    undefined,
    "",
    "abc",
    "0",
    "-5",
    "+5",
    "2.5",
    "0x10",
    "0b11",
    "1e3",
    "1_000",
    " 5",
    "5 ",
    "\t5\n"
];

const megabytes = 1024 * 1024;

describe("Whole-number env setting Tests", (): void => {
    const savedEnv: NodeJS.ProcessEnv = { ...process.env };

    afterEach((): void => {
        process.env = { ...savedEnv };
    });

    describe("parsePositiveInteger", (): void => {
        test.each(["1", "10", "007", "250", "10240", String(Number.MAX_SAFE_INTEGER)])(
            "should accept the plain decimal %p",
            (value: string): void => {
                expect(parsePositiveInteger(value, 42)).toBe(Number(value));
            }
        );

        test.each(invalidValues)("should fall back for %p", (value: string | undefined): void => {
            expect(parsePositiveInteger(value, 42)).toBe(42);
        });

        test.each(["9007199254740992", "9007199254740993", "99999999999999999999"])(
            "should fall back for the unsafe %p",
            (value: string): void => {
                expect(parsePositiveInteger(value, 42)).toBe(42);
            }
        );

        it("should fall back above max and accept max itself", (): void => {
            expect(parsePositiveInteger("11", 42, 10)).toBe(42);
            expect(parsePositiveInteger("10", 42, 10)).toBe(10);
        });
    });

    describe("UPLOAD_USER_QUOTA_MB", (): void => {
        const loadQuotaBytes = (value: string | undefined): number =>
            loadWithEnv<typeof import("../helpers/uploadQuota")>(
                { UPLOAD_USER_QUOTA_MB: value },
                "../helpers/uploadQuota"
            ).defaultUploadQuotaBytes;

        it("should use a plain decimal value", (): void => {
            expect(loadQuotaBytes("2048")).toBe(2048 * megabytes);
        });

        test.each(invalidValues)(
            "should default to 10240 MB for %p",
            (value: string | undefined): void => {
                expect(loadQuotaBytes(value)).toBe(10240 * megabytes);
            }
        );

        test.each(["99999999999", "999999999999999", String(MAX_SAFE_MEGABYTES + 1)])(
            "should default to 10240 MB when %p MB overflows the byte count",
            (value: string): void => {
                expect(loadQuotaBytes(value)).toBe(10240 * megabytes);
            }
        );

        it("should keep the byte count a safe integer at the largest accepted size", (): void => {
            const bytes: number = loadQuotaBytes(String(MAX_SAFE_MEGABYTES));

            expect(Number.isSafeInteger(bytes)).toBe(true);
            expect(bytes).toBe(MAX_SAFE_MEGABYTES * megabytes);
        });
    });

    describe("UPLOAD_MAX_FILESIZE", (): void => {
        const loadMaxBytes = (value: string | undefined): number =>
            loadWithEnv<typeof import("../helpers/multer")>(
                { UPLOAD_MAX_FILESIZE: value },
                "../helpers/multer"
            ).maxFileSizeBytes;

        it("should use a plain decimal value", (): void => {
            expect(loadMaxBytes("25")).toBe(25 * megabytes);
        });

        test.each(invalidValues)(
            "should default to 100 MB for %p",
            (value: string | undefined): void => {
                expect(loadMaxBytes(value)).toBe(100 * megabytes);
            }
        );

        test.each(["99999999999", "999999999999999", String(MAX_SAFE_MEGABYTES + 1)])(
            "should default to 100 MB when %p MB overflows the byte count",
            (value: string): void => {
                expect(loadMaxBytes(value)).toBe(100 * megabytes);
            }
        );
    });
});
