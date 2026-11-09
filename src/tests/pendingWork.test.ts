import { EventEmitter } from "events";
import express from "express";
import { pendingWorkSettled, responseEnded, trackPendingWork } from "../helpers/pendingWork";

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}

const deferred = (): Deferred => {
    let resolve: () => void;
    let reject: (error: Error) => void;
    const promise: Promise<void> = new Promise((res, rej): void => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const fakeResponse = (): express.Response =>
    Object.assign(new EventEmitter(), {
        headersSent: false,
        end: (): void => undefined
    }) as unknown as express.Response;

const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
    let settled: boolean = false;
    promise.then((): boolean => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    return settled;
};

describe("Pending Work Tests", (): void => {
    it("settles at once with no tracked work", async (): Promise<void> => {
        expect(await isSettled(pendingWorkSettled())).toBe(true);
    });

    it("waits for tracked work to finish", async (): Promise<void> => {
        const work: Deferred = deferred();
        const tracked: Promise<void> = trackPendingWork(work.promise);
        const settled: Promise<void> = pendingWorkSettled();

        expect(await isSettled(settled)).toBe(false);

        work.resolve();
        await tracked;

        expect(await isSettled(settled)).toBe(true);
    });

    it("waits for work tracked while waiting", async (): Promise<void> => {
        const first: Deferred = deferred();
        const second: Deferred = deferred();
        const firstTracked: Promise<void> = trackPendingWork(first.promise);
        const settled: Promise<void> = pendingWorkSettled();

        const secondTracked: Promise<void> = trackPendingWork(second.promise);
        first.resolve();
        await firstTracked;

        expect(await isSettled(settled)).toBe(false);

        second.resolve();
        await secondTracked;

        expect(await isSettled(settled)).toBe(true);
    });

    it("stops tracking work that failed", async (): Promise<void> => {
        const work: Deferred = deferred();
        const tracked: Promise<void> = trackPendingWork(work.promise);
        const settled: Promise<void> = pendingWorkSettled();

        work.reject(new Error("failed"));
        await expect(tracked).rejects.toThrow("failed");

        expect(await isSettled(settled)).toBe(true);
    });

    it("passes the work's result through", async (): Promise<void> => {
        await expect(trackPendingWork(Promise.resolve(382))).resolves.toBe(382);
    });

    it("ends a response's wait when it's ended", async (): Promise<void> => {
        const res: express.Response = fakeResponse();
        const ended: Promise<void> = responseEnded(res);

        res.end();

        expect(await isSettled(ended)).toBe(true);
    });

    it("ends a response's wait when it closes after its headers were sent", async (): Promise<void> => {
        const res: express.Response = fakeResponse();
        const ended: Promise<void> = responseEnded(res);

        Object.assign(res, { headersSent: true });
        res.emit("close");

        expect(await isSettled(ended)).toBe(true);
    });

    it("keeps waiting for a response whose client left before the answer", async (): Promise<void> => {
        const res: express.Response = fakeResponse();
        const ended: Promise<void> = responseEnded(res);

        res.emit("close");

        expect(await isSettled(ended)).toBe(false);
    });
});
