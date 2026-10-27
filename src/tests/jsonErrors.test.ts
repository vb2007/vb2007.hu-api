import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";

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

            expect(response.body).toEqual({ error: "request entity too large" });
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
