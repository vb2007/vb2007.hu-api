import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";

const notFoundPath: string = "/no-such-route?a=1&b=2";
const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

const varyTokens = (response: supertest.Response): string[] =>
    (response.headers.vary ?? "").split(",").map((token: string): string => token.trim());

describe("Not Found Tests", (): void => {
    describe("GET an unknown route", (): void => {
        it("should return a JSON 404 without an Accept header", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(notFoundPath)
                .expect("Content-Type", /json/)
                .expect(404);

            expect(response.body).toEqual({ error: Responses.routeNotFound });
            expect(varyTokens(response)).toContain("Accept");
        });

        it("should return a JSON 404 when JSON is accepted", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(notFoundPath)
                .set("Accept", "application/json")
                .expect("Content-Type", /json/)
                .expect(404);

            expect(response.body).toEqual({ error: Responses.routeNotFound });
        });

        it("should redirect a browser navigation to the site's API error page", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(notFoundPath)
                .set("Accept", "text/html")
                .expect("Location", `${baseSiteUrl}/apierror?url=%2Fno-such-route%3Fa%3D1%26b%3D2`)
                .expect(302);

            expect(varyTokens(response)).toContain("Accept");
        });
    });

    describe("HEAD an unknown route", (): void => {
        it("should return 404", async (): Promise<void> => {
            await request(TestData.apiURL).head(notFoundPath).expect(404);
        });
    });
});
