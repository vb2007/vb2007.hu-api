import express from "express";
import net from "net";
import request from "supertest";
import http from "http";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { ignoreRequestsAfterEarlyAnswer } from "../middlewares";
import { Responses } from "../constants/responses";
import {
    OverLimitAnswer,
    sendOverLimitBody,
    sendRawRequests,
    sendRawResponses
} from "./helpers/overLimitBody";
import { TestUser, createTestUser, randomHex } from "./helpers/testUsers";
import { JSON_BODY_MAX_BYTES, PIPELINED_REQUESTS_MAX } from "../constants/limits";

const overLimitBytes: number = 50 * 1024 * 1024;
const followUpWindowMs: number = 1000;

describe("JSON Error Tests", (): void => {
    describe("POST /auth/login", (): void => {
        it.each(["garbage", "{bad", "null", '"x"'])(
            "should return a JSON 400 for the body %s",
            async (body: string): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/auth/login")
                    .set("Content-Type", "application/json")
                    .send(body)
                    .expect("Content-Type", /json/)
                    .expect(400);

                expect(response.body).toEqual({ error: Responses.invalidJson });
                expect(response.text).not.toContain("<html");
                expect(response.text).not.toContain("SyntaxError");
            }
        );

        it("should return a JSON 413 for a too large body", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ padding: "a".repeat(200 * 1024) })
                .expect("Content-Type", /json/)
                .expect(413);

            expect(response.body).toEqual({ error: Responses.requestTooLarge });
        });

        it.each([
            ["a Content-Length over the limit", { "Content-Length": String(overLimitBytes) }],
            ["a streamed body passing the limit", {}],
            [
                "a gzip Content-Length over the limit",
                { "Content-Length": String(overLimitBytes), "Content-Encoding": "gzip" }
            ],
            ["a streamed gzip body passing the limit", { "Content-Encoding": "gzip" }],
            [
                "an Expect: 100-continue with a Content-Length over the limit",
                { "Content-Length": String(overLimitBytes), Expect: "100-continue" }
            ]
        ])(
            "should answer 413 and close the connection before reading all of %s",
            async (description: string, headers: Record<string, string>): Promise<void> => {
                const answer: OverLimitAnswer = await sendOverLimitBody(
                    "/auth/login",
                    { "Content-Type": "application/json", ...headers },
                    '{"padding":"',
                    overLimitBytes
                );

                expect(answer.statuses).toEqual([413]);
                expect(answer.headers).toMatch(/^Connection: close$/im);
                expect(answer.body).toEqual({ error: Responses.requestTooLarge });
                expect(answer.sentBytes).toBeLessThan(overLimitBytes);
            }
        );

        it.each([
            ["a Content-Length over the limit", { "Content-Length": String(overLimitBytes) }],
            ["a streamed body passing the limit", {}]
        ])(
            "should answer 413 to %s pipelined after another request",
            async (description: string, headers: Record<string, string>): Promise<void> => {
                const answer: OverLimitAnswer = await sendOverLimitBody(
                    "/auth/login",
                    { "Content-Type": "application/json", ...headers },
                    '{"padding":"',
                    overLimitBytes,
                    `GET /shortenUrl/${randomHex(4)} HTTP/1.1\r\nHost: ${process.env.APP_IP}\r\n\r\n`
                );

                expect(answer.statuses).toEqual([404, 413]);
                expect(answer.headers).toMatch(/^Connection: close$/im);
                expect(answer.body).toEqual({ error: Responses.requestTooLarge });
                expect(answer.sentBytes).toBeLessThan(overLimitBytes);

                await request(TestData.apiURL).get("/healthz").expect(200);
            }
        );

        it("should answer 400 and close the connection before reading all of a body that isn't JSON", async (): Promise<void> => {
            const answer: OverLimitAnswer = await sendOverLimitBody(
                "/auth/login",
                { "Content-Type": "text/plain" },
                "",
                overLimitBytes
            );

            expect(answer.statuses).toEqual([400]);
            expect(answer.headers).toMatch(/^Connection: close$/im);
            expect(answer.body).toEqual({ error: Responses.Authentication.missingEmailPassword });
            expect(answer.sentBytes).toBeLessThan(overLimitBytes);
        });

        it("should keep the connection open after answering a body read in full", async (): Promise<void> => {
            const agent: http.Agent = new http.Agent({ keepAlive: true });

            const response: http.IncomingMessage = await new Promise((resolve, reject): void => {
                http.request(
                    `${TestData.apiURL}/auth/login`,
                    { method: "POST", agent, headers: { "Content-Type": "application/json" } },
                    (res: http.IncomingMessage): void => {
                        res.resume();
                        resolve(res);
                    }
                )
                    .on("error", reject)
                    .end("{}");
            });
            agent.destroy();

            expect(response.statusCode).toBe(400);
            expect(response.headers.connection).toBe("keep-alive");
        });

        it("should still handle a valid JSON body", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({})
                .expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });
    });

    describe("Requests pipelined after a 413", (): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("jerr");
        });

        const overLimitRequest = (isChunked: boolean): Buffer => {
            const body: Buffer = Buffer.from(
                `{"padding":"${"a".repeat(2 * JSON_BODY_MAX_BYTES)}"}`
            );
            const head: string = `POST /auth/login HTTP/1.1\r\nHost: ${process.env.APP_IP}\r\nContent-Type: application/json\r\n`;

            return isChunked
                ? Buffer.concat([
                      Buffer.from(
                          `${head}Transfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`
                      ),
                      body,
                      Buffer.from("\r\n0\r\n\r\n")
                  ])
                : Buffer.concat([
                      Buffer.from(`${head}Content-Length: ${body.length}\r\n\r\n`),
                      body
                  ]);
        };

        it("should still answer pipelined requests that are not rejected, in order", async (): Promise<void> => {
            const host: string = `Host: ${process.env.APP_IP}`;
            const statuses: number[] = await sendRawRequests(
                Buffer.from(
                    `POST /auth/login HTTP/1.1\r\n${host}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}` +
                        `GET /shortenUrl/${randomHex(4)} HTTP/1.1\r\n${host}\r\n\r\n` +
                        `GET /healthz HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`
                )
            );

            expect(statuses).toEqual([400, 404, 200]);
        });

        it("should answer the requests waiting within the limit in order and the one past it with a 429", async (): Promise<void> => {
            const host: string = `Host: ${process.env.APP_IP}`;
            const health: string = `GET /healthz HTTP/1.1\r\n${host}\r\n\r\n`;
            const responses: string[] = await sendRawResponses(
                Buffer.from(
                    `POST /auth/login HTTP/1.1\r\n${host}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}` +
                        health.repeat(PIPELINED_REQUESTS_MAX + 20)
                )
            );
            const statuses: number[] = responses.map((text: string): number =>
                Number(text.split(" ")[1])
            );

            expect(statuses).toEqual([400, ...Array(PIPELINED_REQUESTS_MAX).fill(200), 429]);
            expect(responses[responses.length - 1]).toMatch(/\r\nConnection: close\r\n/);
            expect(JSON.parse(responses[responses.length - 1].split("\r\n\r\n")[1])).toEqual({
                error: Responses.tooManyPipelinedRequests
            });
        });

        it("should stop reading a connection flooding requests behind one that has not answered", async (): Promise<void> => {
            const app: express.Express = express();
            let held: express.Response | undefined;
            let requestsRead: number = 0;
            app.use(ignoreRequestsAfterEarlyAnswer);
            app.get("/hold", (req: express.Request, res: express.Response): void => {
                held = res;
            });
            const server: http.Server = http.createServer(app);
            server.on("request", (): void => {
                requestsRead++;
            });
            await new Promise<void>((resolve): void => {
                server.listen(0, "127.0.0.1", resolve);
            });
            const socket: net.Socket = net.connect(
                (server.address() as net.AddressInfo).port,
                "127.0.0.1"
            );
            socket.on("error", (): void => undefined);
            const flood: number = 30000;

            socket.write(
                "GET /hold HTTP/1.1\r\nHost: flood\r\n\r\n" +
                    "GET /healthz HTTP/1.1\r\nHost: flood\r\n\r\n".repeat(flood)
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const readWhileHeld: number = requestsRead;
            socket.destroy();
            held?.end();
            await new Promise((resolve) => server.close(resolve));

            expect(readWhileHeld).toBeGreaterThan(PIPELINED_REQUESTS_MAX);
            expect(readWhileHeld).toBeLessThan(flood / 3);
        });

        it.each([
            ["a Content-Length over the limit", false],
            ["a streamed body passing the limit", true]
        ])(
            "should not run a request pipelined after %s",
            async (description: string, isChunked: boolean): Promise<void> => {
                const shortUrlBody: string = JSON.stringify({
                    url: `https://${TestData.runId}-${randomHex(8)}.vb2007.test/`
                });
                const followUp: string = `POST /shortenUrl HTTP/1.1\r\nHost: ${process.env.APP_IP}\r\nCookie: ${user.cookie}\r\nContent-Type: application/json\r\nContent-Length: ${shortUrlBody.length}\r\n\r\n${shortUrlBody}`;

                const statuses: number[] = await sendRawRequests(
                    Buffer.concat([overLimitRequest(isChunked), Buffer.from(followUp)])
                );

                expect(statuses).toEqual([413]);

                await new Promise((resolve) => setTimeout(resolve, followUpWindowMs));

                const response: supertest.Response = await request(TestData.apiURL)
                    .get("/shortenUrls")
                    .set("Cookie", user.cookie)
                    .expect(200);

                expect(response.body.pagination).toMatchObject({ total: 0 });
            }
        );
    });

    describe("GET /paste/:id", (): void => {
        it("should return a JSON 400 for a route parameter that can't be decoded", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/paste/%E0%A4%A")
                .expect("Content-Type", /json/)
                .expect(400);

            expect(response.body).toEqual({ error: "Bad Request" });
            expect(response.text).not.toContain("<html");
            expect(response.text).not.toContain("URIError");
        });
    });
});
