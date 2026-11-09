import { backgroundWorkSettled, trackBackgroundWork } from "../helpers/backgroundWork";

const deferred = () => {
    let resolve: () => void;
    let reject: (error: Error) => void;
    const promise: Promise<void> = new Promise((res, rej): void => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
    let settled: boolean = false;
    promise.then((): boolean => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    return settled;
};

describe("Background Work Tests", (): void => {
    it("settles at once with no tracked work", async (): Promise<void> => {
        expect(await isSettled(backgroundWorkSettled())).toBe(true);
    });

    it("waits for tracked work to finish", async (): Promise<void> => {
        const work = deferred();
        const tracked: Promise<void> = trackBackgroundWork(work.promise);
        const settled: Promise<void> = backgroundWorkSettled();

        expect(await isSettled(settled)).toBe(false);

        work.resolve();
        await tracked;

        expect(await isSettled(settled)).toBe(true);
    });

    it("waits for work tracked while waiting", async (): Promise<void> => {
        const first = deferred();
        const second = deferred();
        const firstTracked: Promise<void> = trackBackgroundWork(first.promise);
        const settled: Promise<void> = backgroundWorkSettled();

        const secondTracked: Promise<void> = trackBackgroundWork(second.promise);
        first.resolve();
        await firstTracked;

        expect(await isSettled(settled)).toBe(false);

        second.resolve();
        await secondTracked;

        expect(await isSettled(settled)).toBe(true);
    });

    it("stops tracking work that failed", async (): Promise<void> => {
        const work = deferred();
        const tracked: Promise<void> = trackBackgroundWork(work.promise);
        const settled: Promise<void> = backgroundWorkSettled();

        work.reject(new Error("failed"));
        await expect(tracked).rejects.toThrow("failed");

        expect(await isSettled(settled)).toBe(true);
    });

    it("passes the work's result through", async (): Promise<void> => {
        await expect(trackBackgroundWork(Promise.resolve(382))).resolves.toBe(382);
    });
});
