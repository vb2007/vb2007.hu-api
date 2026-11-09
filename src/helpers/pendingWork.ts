import express from "express";

const pendingWork: Set<Promise<unknown>> = new Set();

export const trackPendingWork = <T>(work: Promise<T>): Promise<T> => {
    pendingWork.add(work);
    return work.finally((): void => {
        pendingWork.delete(work);
    });
};

export const pendingWorkSettled = async (): Promise<void> => {
    while (pendingWork.size > 0) {
        await Promise.allSettled(pendingWork);
    }
};

export const responseEnded = (res: express.Response): Promise<void> =>
    new Promise((resolve): void => {
        const end: express.Response["end"] = res.end.bind(res);
        res.end = ((...args: Parameters<express.Response["end"]>) => {
            resolve();
            return end(...args);
        }) as express.Response["end"];
        res.on("close", (): void => {
            if (res.headersSent) {
                resolve();
            }
        });
    });
