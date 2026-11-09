import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { OverLimitAnswer, sendOverLimitBody } from "./helpers/overLimitBody";

const overLimitBytes: number = 50 * 1024 * 1024;

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
            ["a streamed body passing the limit", {}]
        ])(
            "should answer 413 and close the connection before reading all of %s",
            async (description: string, headers: Record<string, string>): Promise<void> => {
                const answer: OverLimitAnswer = await sendOverLimitBody(
                    "/auth/login",
                    { "Content-Type": "application/json", ...headers },
                    '{"padding":"',
                    overLimitBytes
                );

                expect(answer.status).toBe(413);
                expect(answer.headers).toMatch(/^Connection: close$/im);
                expect(answer.body).toEqual({ error: Responses.requestTooLarge });
                expect(answer.sentBytes).toBeLessThan(overLimitBytes);
            }
        );

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
