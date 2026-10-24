import dotenv from "dotenv";
dotenv.config();

export const testEmailDomainSuffix: string = ".vb2007.test";

export class TestData {
    static readonly apiURL: string = `http://${process.env.APP_IP}:${process.env.APP_PORT}`;
    static readonly runId: string = process.env.TEST_RUN_ID;
    static readonly emailDomain: string = `${process.env.TEST_RUN_ID}${testEmailDomainSuffix}`;
    static readonly superuser = {
        id: process.env.TEST_SUPERUSER_ID,
        username: process.env.TEST_SUPERUSER_USERNAME,
        email: process.env.SUPERUSER_EMAIL,
        cookie: process.env.TEST_SUPERUSER_COOKIE
    };
    static PastebinData = class {
        static readonly testPasteContent: string =
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.";
    };
    static ShortUrlData = class {
        static readonly unsupportedProtocol: string = "unsupported://protocol.com";
        static readonly containsSpaces: string = "http://in val idurl.com";
    };
}
