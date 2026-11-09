const pendingWork: Set<Promise<unknown>> = new Set();

export const trackBackgroundWork = <T>(work: Promise<T>): Promise<T> => {
    pendingWork.add(work);
    return work.finally((): void => {
        pendingWork.delete(work);
    });
};

export const backgroundWorkSettled = async (): Promise<void> => {
    while (pendingWork.size > 0) {
        await Promise.allSettled(pendingWork);
    }
};
