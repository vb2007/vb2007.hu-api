import net from "net";

export interface OverLimitAnswer {
    statuses: number[];
    headers: string;
    body: unknown;
    sentBytes: number;
}

const chunkBytes: number = 64 * 1024;
const chunkIntervalMs: number = 1;
const closeTimeoutMs: number = 5000;

const encodeChunk = (chunk: Buffer, isChunked: boolean): Buffer =>
    isChunked
        ? Buffer.concat([
              Buffer.from(`${chunk.length.toString(16)}\r\n`),
              chunk,
              Buffer.from("\r\n")
          ])
        : chunk;

const splitResponses = (response: string): string[] =>
    response.split(/(?=HTTP\/1\.1 \d{3} )/).filter(Boolean);

const parseAnswer = (response: string, sentBytes: number): OverLimitAnswer => {
    const responses: string[] = splitResponses(response);
    const [headers, body] = responses[responses.length - 1].split("\r\n\r\n");

    return {
        statuses: responses.map((text: string): number => Number(text.split(" ")[1])),
        headers,
        body: JSON.parse(body),
        sentBytes
    };
};

export const sendOverLimitBody = (
    path: string,
    headers: Record<string, string>,
    firstBytes: string,
    totalBytes: number,
    precedingRequest: string = ""
): Promise<OverLimitAnswer> =>
    new Promise((resolve, reject): void => {
        const isChunked: boolean = !("Content-Length" in headers);
        const expectedResponses: number = precedingRequest ? 2 : 1;
        const socket: net.Socket = net.connect(Number(process.env.APP_PORT), process.env.APP_IP);
        let sentBytes: number = 0;
        let response: string = "";
        let closeTimeout: NodeJS.Timeout | undefined;

        const isAnswered = (): boolean => splitResponses(response).length >= expectedResponses;

        const writeMore = (): void => {
            if (isAnswered() || socket.destroyed) {
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
                setTimeout(writeMore, chunkIntervalMs);
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
            socket.write(`${precedingRequest}${requestHead.join("\r\n")}\r\n\r\n`);
            writeMore();
        });
        socket.on("data", (data: Buffer): void => {
            response += data.toString();

            if (isAnswered() && !closeTimeout) {
                closeTimeout = setTimeout((): void => {
                    reject(new Error("The server kept the connection open after its answer"));
                    socket.destroy();
                }, closeTimeoutMs);
            }
        });
        socket.on("error", (error: Error): void => {
            if (!isAnswered()) {
                reject(error);
            }
        });
        socket.on("close", (): void => {
            clearTimeout(closeTimeout);

            if (!isAnswered()) {
                reject(
                    new Error(`The server closed the connection without an answer: ${response}`)
                );
                return;
            }

            try {
                resolve(parseAnswer(response, sentBytes));
            } catch (error) {
                reject(error);
            }
        });
    });

export const sendRawRequests = (raw: Buffer): Promise<number[]> =>
    new Promise((resolve, reject): void => {
        const socket: net.Socket = net.connect(Number(process.env.APP_PORT), process.env.APP_IP);
        let response: string = "";

        socket.on("connect", (): void => {
            socket.write(raw);
        });
        socket.on("data", (data: Buffer): void => {
            response += data.toString();
        });
        socket.on("error", (error: Error): void => {
            if (!response) {
                reject(error);
            }
        });
        socket.on("close", (): void => {
            resolve(
                splitResponses(response).map((text: string): number => Number(text.split(" ")[1]))
            );
        });
    });
