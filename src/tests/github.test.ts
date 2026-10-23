import { createCodeChallenge, deriveUsername } from "../helpers/github";

const takenBy =
    (usernames: string[]) =>
    async (username: string): Promise<boolean> =>
        usernames.includes(username);

describe("GitHub OAuth helpers", (): void => {
    describe("createCodeChallenge", (): void => {
        it("should match the RFC 7636 S256 example", (): void => {
            expect(createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
            );
        });
    });

    describe("deriveUsername", (): void => {
        it("should keep a free GitHub login as is", async (): Promise<void> => {
            expect(await deriveUsername("octocat", takenBy([]))).toBe("octocat");
        });

        it("should cut logins longer than 16 characters", async (): Promise<void> => {
            expect(await deriveUsername("a-very-long-github-login", takenBy([]))).toBe(
                "a-very-long-gith"
            );
        });

        it("should pad one character logins to 2 characters", async (): Promise<void> => {
            expect(await deriveUsername("a", takenBy([]))).toBe("a0");
        });

        it("should add a numeric suffix when the login is taken", async (): Promise<void> => {
            expect(await deriveUsername("octocat", takenBy(["octocat", "octocat1"]))).toBe(
                "octocat2"
            );
        });

        it("should stay within 16 characters with a suffix", async (): Promise<void> => {
            expect(await deriveUsername("sixteen-chars-ab", takenBy(["sixteen-chars-ab"]))).toBe(
                "sixteen-chars-a1"
            );
        });
    });
});
