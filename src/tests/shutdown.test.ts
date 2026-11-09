import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import request from "supertest";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";

interface RunningApi {
    port: number;
    output: () => string;
    hasExited: () => boolean;
    stop: (signal?: NodeJS.Signals) => void;
    exitCode: Promise<number | null>;
}

const apiIp: string = "127.0.0.1";
const testJpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const runningApis: ChildProcess[] = [];

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = (): Promise<number> =>
    new Promise((resolve): void => {
        const server: net.Server = net.createServer().listen(0, apiIp, (): void => {
            const { port } = server.address() as net.AddressInfo;
            server.close((): void => resolve(port));
        });
    });

const isHealthy = (port: number): Promise<boolean> =>
    new Promise((resolve): void => {
        http.get({ host: apiIp, port, path: "/healthz", agent: false }, (res): void => {
            res.resume();
            resolve(res.statusCode === 200);
        }).on("error", (): void => resolve(false));
    });

const waitForOutput = async (api: RunningApi, text: string): Promise<void> => {
    while (!api.output().includes(text)) {
        if (api.hasExited()) {
            throw new Error(`The API exited before printing "${text}":\n${api.output()}`);
        }
        await wait(20);
    }
};

const startApi = async (
    env: Record<string, string> = {},
    attemptsLeft: number = 3
): Promise<RunningApi> => {
    const port: number = await freePort();
    let output: string = "";

    const child: ChildProcess = spawn(
        process.execPath,
        ["-r", "ts-node/register", path.join(__dirname, "..", "index.ts")],
        {
            env: {
                ...process.env,
                ...env,
                APP_IP: apiIp,
                APP_PORT: String(port),
                TS_NODE_TRANSPILE_ONLY: "true"
            }
        }
    );
    runningApis.push(child);
    child.stdout.on("data", (chunk: Buffer): void => {
        output += chunk;
    });
    child.stderr.on("data", (chunk: Buffer): void => {
        output += chunk;
    });

    const api: RunningApi = {
        port,
        output: (): string => output,
        hasExited: (): boolean => child.exitCode !== null || child.signalCode !== null,
        stop: (signal: NodeJS.Signals = "SIGTERM"): void => {
            child.kill(signal);
        },
        exitCode: new Promise((resolve): void => {
            child.on("exit", resolve);
        })
    };

    try {
        await waitForOutput(api, `Server is running on http://${apiIp}:${port}`);
    } catch (error) {
        if (attemptsLeft > 1 && output.includes("EADDRINUSE")) {
            return startApi(env, attemptsLeft - 1);
        }
        throw error;
    }

    while (!(await isHealthy(port))) {
        if (api.hasExited()) {
            throw new Error(`The API exited before it was ready:\n${output}`);
        }
        await wait(100);
    }

    return api;
};

const filesIn = (dir: string): Promise<string[]> =>
    fs.promises.readdir(dir).catch((): string[] => []);

const startUpload = (api: RunningApi, cookie: string): net.Socket => {
    const boundary: string = `upload${randomHex(4)}`;
    const part: string =
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="partial.png"\r\n\r\n' +
        "a".repeat(64 * 1024);
    const socket: net.Socket = net.connect(api.port, apiIp, (): void => {
        socket.write(
            "POST /upload HTTP/1.1\r\n" +
                `Host: ${apiIp}\r\n` +
                `Cookie: ${cookie.split(";")[0]}\r\n` +
                `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
                "Transfer-Encoding: chunked\r\n\r\n" +
                `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`
        );
    });
    socket.on("error", (): void => undefined);
    return socket;
};

const timeExit = async (api: RunningApi): Promise<{ code: number | null; ms: number }> => {
    const startedAt: number = Date.now();
    const code: number | null = await api.exitCode;
    return { code, ms: Date.now() - startedAt };
};

describe("Graceful Shutdown Tests", (): void => {
    let user: TestUser;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("shut");
    });

    afterAll((): void => {
        runningApis.forEach((api: ChildProcess): void => {
            if (api.exitCode === null) {
                api.kill("SIGKILL");
            }
        });
    });

    it("exits at once with 0 while a connection never sends a request", async (): Promise<void> => {
        const api: RunningApi = await startApi();
        const socket: net.Socket = net.connect(api.port, apiIp);
        await new Promise((resolve) => socket.on("connect", resolve));
        socket.on("error", (): void => undefined);

        api.stop();
        const { code, ms } = await timeExit(api);

        expect(code).toBe(0);
        expect(ms).toBeLessThan(3000);
        expect(socket.destroyed || socket.readableEnded).toBe(true);
        socket.destroy();
    });

    it("answers an in-flight request with Connection: close before exiting", async (): Promise<void> => {
        const api: RunningApi = await startApi();
        const agent: http.Agent = new http.Agent({ keepAlive: true });
        const body: string = JSON.stringify({
            email: testEmailOf(`shut${randomHex(5)}`),
            password: randomHex(8)
        });

        const response: Promise<http.IncomingMessage> = new Promise((resolve, reject): void => {
            const req: http.ClientRequest = http.request(
                {
                    host: apiIp,
                    port: api.port,
                    method: "POST",
                    path: "/auth/login",
                    agent,
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                        Expect: "100-continue"
                    }
                },
                (res: http.IncomingMessage): void => {
                    res.resume();
                    res.on("end", (): void => resolve(res));
                }
            );
            req.on("error", reject);
            req.on("continue", (): void => {
                api.stop();
                waitForOutput(api, "SIGTERM received").then((): void => {
                    req.end(body);
                }, reject);
            });
            req.flushHeaders();
        });

        const answered: http.IncomingMessage = await response;
        const { code, ms } = await timeExit(api);
        agent.destroy();

        expect(answered.statusCode).toBe(403);
        expect(answered.headers.connection).toBe("close");
        expect(code).toBe(0);
        expect(ms).toBeLessThan(3000);
    });

    it("finishes a password reset whose client left before the answer", async (): Promise<void> => {
        const api: RunningApi = await startApi();
        const body: string = JSON.stringify({ email: user.email });
        const socket: net.Socket = net.connect(api.port, apiIp, (): void => {
            socket.end(
                "POST /auth/password-reset HTTP/1.1\r\n" +
                    `Host: ${apiIp}\r\n` +
                    "Content-Type: application/json\r\n" +
                    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
                    body
            );
        });
        socket.on("error", (): void => undefined);
        socket.resume();
        socket.on("end", (): void => api.stop());

        const code: number | null = await api.exitCode;
        const output: string = api.output();
        const mailAt: number = output.indexOf(`To: ${user.email}`);

        expect(code).toBe(0);
        expect(output).toMatch(/is your vb2007\.hu password reset code/);
        expect(mailAt).toBeGreaterThan(-1);
        expect(mailAt).toBeLessThan(output.indexOf("Shutdown complete"));
    });

    it("removes an upload still streaming when it exits before the upload ends", async (): Promise<void> => {
        const uploadDir: string = path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id, "api");
        const userUploadDir: string = path.join(uploadDir, user.id);
        const api: RunningApi = await startApi({ UPLOAD_DISK_DIRECTORY: uploadDir });

        const completed = await request(`http://${apiIp}:${api.port}`)
            .post("/upload")
            .set("Cookie", user.cookie)
            .attach("file", testJpeg, "kept.jpg");
        expect(completed.status).toBe(201);

        const socket: net.Socket = startUpload(api, user.cookie);
        while ((await filesIn(userUploadDir)).length < 2) {
            if (api.hasExited()) {
                throw new Error(`The API exited before the upload started:\n${api.output()}`);
            }
            await wait(20);
        }

        api.stop();
        await waitForOutput(api, "SIGTERM received");
        api.stop();
        const code: number | null = await api.exitCode;
        socket.destroy();

        expect(code).toBe(1);
        expect(api.output()).toContain(`Removed partial upload ${userUploadDir}`);
        expect(await filesIn(userUploadDir)).toEqual([`${completed.body.upload.id}.jpg`]);
    });
});
