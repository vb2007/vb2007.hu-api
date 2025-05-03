import dotenv from "dotenv";
dotenv.config();

export class TestData {
    static readonly apiURL: string = process.env.APP_IP + ":" + process.env.APP_PORT;
    static readonly email: string = process.env.TEST_EMAIL;
    static readonly password: string = process.env.TEST_PASSWORD;
}
