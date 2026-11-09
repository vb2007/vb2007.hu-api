import net from "net";

export interface OverLimitAnswer {
    status: number;
    headers: string;
    body: unknown;
    sentBytes: number;
}

const chunkBytes: number = 64 * 1024;
const closeTimeoutMs: number = 5000;

const encodeChunk = (chunk: Buffer, isChunked: boolean): Buffer =>
    isChunked
        ? Buffer.concat([
              Buffer.from(`${chunk.length.toString(16)}\r\n`),
              chunk,
              Buffer.from("\r\n")
          ])
        : chunk;

const parseAnswer = (response: string, sentBytes: number): OverLimitAnswer => {
    const [headers, body] = response.split("\r\n\r\n");

    return { status: Number(headers.split(" ")[1]), headers, body: JSON.parse(body), sentBytes };
};

export const sendOverLimitBody = (
    path: string,
    headers: Record<string, string>,
    firstBytes: string,
    totalBytes: number
): Promise<OverLimitAnswer> =>
    new Promise((resolve, reject): void => {
        const isChunked: boolean = !("Content-Length" in headers);
        const socket: net.Socket = net.connect(Number(process.env.APP_PORT), process.env.APP_IP);
        let sentBytes: number = 0;
        let response: string = "";

        const writeMore = (): void => {
            if (response || socket.destroyed) {
                return;
            }

            if (sentBytes >= totalBytes) {
                if (isChunked) {
                    socket.write("0\r\n\r\n");
                }
                return;
            }

            const chunk: Buffer = Buffer.alloc(Math.min(chunkBytes, totalBytes - sentBytes), "a");

            if (sentBytes === 0) {
                chunk.write(firstBytes);
            }

            sentBytes += chunk.length;

            if (socket.write(encodeChunk(chunk, isChunked))) {
                setImmediate(writeMore);
            } else {
                socket.once("drain", writeMore);
            }
        };

        const requestHead: string[] = [
            `POST ${path} HTTP/1.1`,
            `Host: ${process.env.APP_IP}`,
            ...Object.entries(headers).map(([name, value]): string => `${name}: ${value}`),
            ...(isChunked ? ["Transfer-Encoding: chunked"] : [])
        ];

        socket.on("connect", (): void => {
            socket.write(`${requestHead.join("\r\n")}\r\n\r\n`);
            writeMore();
        });
        socket.on("data", (data: Buffer): void => {
            if (!response) {
                setTimeout((): void => {
                    reject(new Error("The server kept the connection open after its answer"));
                    socket.destroy();
                }, closeTimeoutMs).unref();
            }
            response += data.toString();
        });
        socket.on("error", (error: Error): void => {
            if (!response) {
                reject(error);
            }
        });
        socket.on("close", (): void => {
            if (response) {
                resolve(parseAnswer(response, sentBytes));
            } else {
                reject(new Error("The server closed the connection without an answer"));
            }
        });
    });
