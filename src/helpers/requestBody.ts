import express from "express";
import http from "http";
import net from "net";

const closeLingerMs: number = 5 * 1000;

const closingSockets: WeakSet<net.Socket> = new WeakSet();

export const isClosingAfterEarlyAnswer = (socket: net.Socket): boolean =>
    closingSockets.has(socket);

const hasUnreadBody = (req: http.IncomingMessage): boolean =>
    !req.complete &&
    (req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"]) > 0);

const closeAfterAnswer = (res: http.ServerResponse): void => {
    const socket: net.Socket = res.req.socket;
    closingSockets.add(socket);
    // Node destroys a Connection: close socket once the answer is written, and the client's unread upload then resets it before the client reads the answer
    socket.destroySoon = (): void => {
        socket.end();
        const linger: NodeJS.Timeout = setTimeout((): void => {
            socket.destroy();
        }, closeLingerMs).unref();
        socket.once("close", (): void => clearTimeout(linger));
    };

    res.setHeader("Connection", "close");
};

export const closeWhenBodyUnread = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
): void => {
    const writeHead: express.Response["writeHead"] = res.writeHead;
    res.writeHead = ((...args: Parameters<express.Response["writeHead"]>) => {
        if (hasUnreadBody(req)) {
            closeAfterAnswer(res);
        }
        return writeHead.apply(res, args);
    }) as express.Response["writeHead"];
    next();
};

export const answerTooLarge = (res: express.Response, error: string): void => {
    if (res.headersSent) {
        return;
    }

    closeAfterAnswer(res);
    res.status(413).json({ error });
};
