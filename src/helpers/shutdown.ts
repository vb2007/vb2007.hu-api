import http from "http";
import net from "net";
import mongoose from "mongoose";

import { pendingWorkSettled } from "./pendingWork";
import { removeUploadsInFlight } from "./partialUploads";

const shutdownDeadlineMs: number = 8 * 1000;

export const shutDownOnSignals = (server: http.Server): void => {
    let isShuttingDown: boolean = false;
    const idleSockets: Set<net.Socket> = new Set();
    const pendingResponses: Set<http.ServerResponse> = new Set();

    server.on("connection", (socket: net.Socket): void => {
        idleSockets.add(socket);
        socket.on("close", (): void => {
            idleSockets.delete(socket);
        });
    });

    server.prependListener(
        "request",
        (req: http.IncomingMessage, res: http.ServerResponse): void => {
            idleSockets.delete(req.socket);
            pendingResponses.add(res);

            if (isShuttingDown) {
                res.shouldKeepAlive = false;
            }

            res.on("close", (): void => {
                pendingResponses.delete(res);

                if (isShuttingDown) {
                    req.socket.end();
                } else if (!req.socket.destroyed) {
                    idleSockets.add(req.socket);
                }
            });
        }
    );

    const closeServer = (): Promise<void> =>
        new Promise((resolve, reject): void => {
            server.close((error?: NodeJS.ErrnoException): void => {
                if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                    reject(error);
                    return;
                }
                resolve();
            });
            idleSockets.forEach((socket: net.Socket): void => {
                socket.destroy();
            });
            pendingResponses.forEach((res: http.ServerResponse): void => {
                res.shouldKeepAlive = false;
            });
        });

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (isShuttingDown) {
            console.error(`${signal} received during shutdown, exiting now`);
            process.exit(1);
        }
        isShuttingDown = true;
        console.log(`${signal} received, shutting down`);

        setTimeout((): void => {
            console.error(`Shutdown took over ${shutdownDeadlineMs / 1000} s, exiting anyway`);
            process.exit(1);
        }, shutdownDeadlineMs);

        try {
            await closeServer();
            await pendingWorkSettled();
            await mongoose.disconnect();
            console.log("Shutdown complete");
            process.exit(0);
        } catch (error) {
            console.error("Shutdown failed:", error);
            process.exit(1);
        }
    };

    process.on("exit", removeUploadsInFlight);
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};
