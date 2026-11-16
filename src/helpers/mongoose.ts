export const isIndexNotFoundError = (error: unknown): boolean =>
    (error as { code?: number })?.code === 27;
