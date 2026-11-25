const locks: Map<string, Promise<unknown>> = new Map();

export const withLock = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const current: Promise<T> = (locks.get(key) ?? Promise.resolve())
        .catch((): void => undefined)
        .then(task);

    locks.set(key, current);

    try {
        return await current;
    } finally {
        if (locks.get(key) === current) {
            locks.delete(key);
        }
    }
};
