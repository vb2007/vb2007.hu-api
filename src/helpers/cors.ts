export const parseCorsOrigins = (value: string | undefined): string[] => {
    const origins: string[] = (value ?? "")
        .split(",")
        .map((origin: string) => origin.trim())
        .filter((origin: string) => origin !== "");

    if (origins.length === 0) {
        throw new Error(
            "CORS_ORIGIN_URLS is missing or empty: set it to the allowed frontend origins (comma separated), see docs/dotenv-setup.md"
        );
    }

    return origins;
};
