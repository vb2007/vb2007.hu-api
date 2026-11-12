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

const isInterimResponse = (text: string): boolean => /^HTTP\/1\.1 1\d\d /.test(text);

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
        const waitsForContinue: boolean = headers.Expect === "100-continue";
        const expectedResponses: number = precedingRequest ? 2 : 1;
        const socket: net.Socket = net.connect(Number(process.env.APP_PORT), process.env.APP_IP);
        let sentBytes: number = 0;
        let response: string = "";
        let closeTimeout: NodeJS.Timeout | undefined;

        let isSending: boolean = false;

        const isAnswered = (): boolean =>
            splitResponses(response).filter((text: string): boolean => !isInterimResponse(text))
                .length >= expectedResponses;

        const startSending = (): void => {
            if (!isSending) {
                isSending = true;
                writeMore();
            }
        };

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

            const chunk: Buffer =
                sentBytes === 0
                    ? Buffer.concat([
                          Buffer.from(firstBytes),
                          Buffer.alloc(
                              Math.max(0, Math.min(chunkBytes, totalBytes) - firstBytes.length),
                              "a"
                          )
                      ])
                    : Buffer.alloc(Math.min(chunkBytes, totalBytes - sentBytes), "a");

            sentBytes += chunk.length;

            const writeLater = (): void => {
                setTimeout(writeMore, chunkIntervalMs);
            };

            if (socket.write(encodeChunk(chunk, isChunked))) {
                writeLater();
            } else {
                socket.once("drain", writeLater);
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

            if (!waitsForContinue) {
                startSending();
            }
        });
        socket.on("data", (data: Buffer): void => {
            response += data.toString();

            if (splitResponses(response).some(isInterimResponse)) {
                startSending();
            }

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

export const sendRawResponses = (raw: Buffer): Promise<string[]> =>
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
            resolve(splitResponses(response));
        });
    });

export const sendRawRequests = async (raw: Buffer): Promise<number[]> =>
    (await sendRawResponses(raw)).map((text: string): number => Number(text.split(" ")[1]));
