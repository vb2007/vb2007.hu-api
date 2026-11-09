import { ChildProcess, spawn } from "child_process";
import http from "http";
import net from "net";
import path from "path";
import { TestUser, createTestUser, randomHex, testEmailOf } from "./helpers/testUsers";

interface RunningApi {
    port: number;
    output: () => string;
    stop: (signal?: NodeJS.Signals) => void;
    exitCode: Promise<number | null>;
}

const apiIp: string = "127.0.0.1";
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

const startApi = async (): Promise<RunningApi> => {
    const port: number = await freePort();
    let output: string = "";
    let exited: boolean = false;

    const api: ChildProcess = spawn(
        process.execPath,
        ["-r", "ts-node/register", path.join(__dirname, "..", "index.ts")],
        {
            env: {
                ...process.env,
                APP_IP: apiIp,
                APP_PORT: String(port),
                TS_NODE_TRANSPILE_ONLY: "true"
            }
        }
    );
    runningApis.push(api);
    api.stdout.on("data", (chunk: Buffer): void => {
        output += chunk;
    });
    api.stderr.on("data", (chunk: Buffer): void => {
        output += chunk;
    });

    const exitCode: Promise<number | null> = new Promise((resolve): void => {
        api.on("exit", (code: number | null): void => {
            exited = true;
            resolve(code);
        });
    });

    while (!(await isHealthy(port))) {
        if (exited) {
            throw new Error(`The API exited before it was ready:\n${output}`);
        }
        await wait(100);
    }

    return {
        port,
        output: (): string => output,
        stop: (signal: NodeJS.Signals = "SIGTERM"): void => {
            api.kill(signal);
        },
        exitCode
    };
};

const waitForOutput = async (api: RunningApi, text: string): Promise<void> => {
    while (!api.output().includes(text)) {
        await wait(20);
    }
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
            req.on("continue", async (): Promise<void> => {
                api.stop();
                await waitForOutput(api, "SIGTERM received");
                req.end(body);
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
});
