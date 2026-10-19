import request from "supertest";
import { TestData } from "../constants/testData";

describe("Health Check API Tests", (): void => {
    describe("GET /healthz", (): void => {
        it("should return 200 when the database is connected", async (): Promise<void> => {
            await request(TestData.apiURL).get("/healthz").expect(200);
        });
    });
});
