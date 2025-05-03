import dotenv from "dotenv";
dotenv.config();

export class TestData {
    static readonly apiURL: string = process.env.APP_IP + ":" + process.env.APP_PORT;
    static readonly username: string = "testuser";
    static readonly password: string = "testpassword";
}
