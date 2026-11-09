import express from "express";
import net from "net";

const tooLargeLingerMs: number = 5 * 1000;

export const answerTooLarge = (res: express.Response, error: string): void => {
    if (res.headersSent) {
        return;
    }

    const socket: net.Socket = res.req.socket;
    // Node destroys a Connection: close socket once the answer is written, and the client's unread upload then resets it before the client reads the answer
    socket.destroySoon = (): void => {
        socket.end();
        const linger: NodeJS.Timeout = setTimeout((): void => {
            socket.destroy();
        }, tooLargeLingerMs).unref();
        socket.once("close", (): void => clearTimeout(linger));
    };

    res.set("Connection", "close").status(413).json({ error });
};
