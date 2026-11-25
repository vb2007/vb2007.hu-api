import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { sharexTokenPlaceholder } from "../helpers/sharex";

const uploaders: [string, string, string, string][] = [
    ["upload", "ImageUploader, FileUploader", "/upload", "MultipartFormData"],
    ["paste", "TextUploader", "/paste", "JSON"],
    ["shorten", "URLShortener", "/shortenUrl", "JSON"]
];

describe("ShareX Uploader Tests", (): void => {
    describe.each(uploaders)(
        "GET /sharex/%s.sxcu",
        (name: string, destinationType: string, endpoint: string, body: string): void => {
            const get = (host?: string): supertest.Test => {
                const test: supertest.Test = request(TestData.apiURL)
                    .get(`/sharex/${name}.sxcu`)
                    .set("X-Forwarded-Proto", "https");

                return host === undefined ? test : test.set("Host", host);
            };

            it("should serve the uploader to anyone, as a download that isn't cached", async (): Promise<void> => {
                const response: supertest.Response = await get("api.example.test")
                    .expect("Content-Type", /json/)
                    .expect("Content-Disposition", `attachment; filename="vb2007-${name}.sxcu"`)
                    .expect("Cache-Control", "private, no-store")
                    .expect(200);

                expect(response.body).toMatchObject({
                    DestinationType: destinationType,
                    RequestMethod: "POST",
                    RequestURL: `https://api.example.test${endpoint}`,
                    Body: body,
                    Headers: { Authorization: `Bearer ${sharexTokenPlaceholder}` }
                });
            });

            it("should build the API address from the request", async (): Promise<void> => {
                const response: supertest.Response = await get("localhost:3000").expect(200);

                expect(response.body.RequestURL).toBe(`https://localhost:3000${endpoint}`);
            });

            it.each(["api.example.test/evil", "api example.test", "user@api.example.test", ""])(
                "should refuse the Host header %p",
                async (host: string): Promise<void> => {
                    const response: supertest.Response = await get(host).expect(400);

                    expect(response.body).toEqual({ error: Responses.Sharex.invalidHost });
                }
            );
        }
    );

    it("should point the shortener's link at the API and the paste's at the site", async (): Promise<void> => {
        const shorten: supertest.Response = await request(TestData.apiURL)
            .get("/sharex/shorten.sxcu")
            .set("Host", "api.example.test")
            .expect(200);
        const paste: supertest.Response = await request(TestData.apiURL)
            .get("/sharex/paste.sxcu")
            .expect(200);

        expect(shorten.body.URL).toBe("http://api.example.test/r/{json:data.shortenedUrl}");
        expect(paste.body.URL).toBe(
            `${process.env.BASE_SITE_URL || "https://vb2007.hu"}/pastebin/{json:paste._id}`
        );
    });
});
