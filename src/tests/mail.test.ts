import {
    EMAIL_CODE_RESEND_SECONDS,
    createEmailCode,
    isEmailCodeMatch,
    hashEmailCode,
    normalizeEmailCode,
    resendWaitSeconds
} from "../helpers/emailCodes";
import { Emails } from "../constants/emails";

type MailModule = typeof import("../helpers/mail");

const smtpEnv: Record<string, string> = {
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASSWORD: "password",
    MAIL_FROM: "vb2007.hu <noreply@vb2007.hu>"
};

const mockSendMail: jest.Mock = jest.fn();
const mockCreateTransport: jest.Mock = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock("nodemailer", () => ({
    __esModule: true,
    default: { createTransport: (options: object) => mockCreateTransport(options) }
}));

const loadMail = (env: Record<string, string | undefined>): MailModule => {
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    let mail: MailModule;
    jest.isolateModules((): void => {
        mail = require("../helpers/mail");
    });

    return mail;
};

describe("Mail Tests", (): void => {
    const mail = { to: "someone@vb2007.hu", ...Emails.registrationCode("123456", 15) };
    const sendMail: jest.Mock = mockSendMail;
    const savedEnv: NodeJS.ProcessEnv = { ...process.env };

    beforeEach((): void => {
        sendMail.mockReset().mockResolvedValue({});
        mockCreateTransport.mockClear();
        jest.spyOn(console, "warn").mockImplementation((): void => undefined);
        jest.spyOn(console, "log").mockImplementation((): void => undefined);
    });

    afterEach((): void => {
        process.env = { ...savedEnv };
        jest.restoreAllMocks();
    });

    describe("sendMail", (): void => {
        it("should send through SMTP from MAIL_FROM", async (): Promise<void> => {
            await loadMail(smtpEnv).sendMail(mail);

            expect(mockCreateTransport).toHaveBeenCalledWith({
                host: "smtp.example.test",
                port: 587,
                secure: false,
                auth: { user: "user", pass: "password" }
            });
            expect(sendMail).toHaveBeenCalledWith({ from: smtpEnv.MAIL_FROM, ...mail });
        });

        it("should use implicit TLS on port 465", async (): Promise<void> => {
            await loadMail({ ...smtpEnv, SMTP_PORT: "465" }).sendMail(mail);

            expect(mockCreateTransport).toHaveBeenCalledWith(
                expect.objectContaining({ port: 465, secure: true })
            );
        });

        test.each([
            "x@local.vb2007.test",
            "x@example",
            "x@a.example",
            "x@a.invalid",
            "x@localhost"
        ])("should not send to the reserved address %s", async (to: string): Promise<void> => {
            const { sendMail: send, isReservedEmailDomain } = loadMail(smtpEnv);

            await send({ ...mail, to });

            expect(sendMail).not.toHaveBeenCalled();
            expect(isReservedEmailDomain(to)).toBe(true);
        });

        it("should log the mail outside production when SMTP isn't set", async (): Promise<void> => {
            await loadMail({ SMTP_HOST: undefined, NODE_ENV: "development" }).sendMail(mail);

            expect(sendMail).not.toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalled();
            expect(console.log).toHaveBeenCalledWith(expect.stringContaining("123456"));
        });

        it("should not log the mail in production", async (): Promise<void> => {
            await loadMail({ SMTP_HOST: undefined, NODE_ENV: "production" }).sendMail(mail);

            expect(sendMail).not.toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalled();
            expect(console.log).not.toHaveBeenCalled();
        });

        it("should pass SMTP errors on", async (): Promise<void> => {
            sendMail.mockRejectedValue(new Error("535 Authentication failed"));

            await expect(loadMail(smtpEnv).sendMail(mail)).rejects.toThrow("535");
        });
    });

    describe("e-mail codes", (): void => {
        it("should create 6 digit codes", (): void => {
            for (let attempt = 0; attempt < 50; attempt++) {
                expect(createEmailCode()).toMatch(/^\d{6}$/);
            }
        });

        it("should only match the code in its own scope", (): void => {
            const hash: string = hashEmailCode("registration:a@vb2007.hu", "012345");

            expect(isEmailCodeMatch(hash, "registration:a@vb2007.hu", "012345")).toBe(true);
            expect(isEmailCodeMatch(hash, "registration:b@vb2007.hu", "012345")).toBe(false);
            expect(isEmailCodeMatch(hash, "registration:a@vb2007.hu", "012346")).toBe(false);
            expect(isEmailCodeMatch(hash, "registration:a@vb2007.hu", "12345")).toBe(false);
        });

        it("should ignore spaces in a typed code", (): void => {
            expect(normalizeEmailCode(" 012 345\n")).toBe("012345");
        });

        it("should count down the resend cooldown", (): void => {
            expect(resendWaitSeconds(undefined)).toBe(0);
            expect(resendWaitSeconds(new Date())).toBe(EMAIL_CODE_RESEND_SECONDS);
            expect(resendWaitSeconds(new Date(Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000))).toBe(
                0
            );
        });
    });
});
