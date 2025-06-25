import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

export class TestData {
    static readonly apiURL: string = `http://${process.env.APP_IP}:${process.env.APP_PORT}`;
    static readonly username: string = process.env.TEST_USERNAME;
    static readonly email: string = process.env.TEST_EMAIL;
    static readonly password: string = process.env.TEST_PASSWORD;
    static PastebinData = class {
        static readonly testPasteId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId(
            "67f95e65817c1557a2228ff7"
        );
        static readonly testPasteContent: string =
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.";
    };
}
