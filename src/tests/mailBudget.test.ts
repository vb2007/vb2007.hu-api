import { Emails } from "../constants/emails";

type MailModule = typeof import("../helpers/mail");

const smtpEnv: Record<string, string> = {
    SMTP_HOST: "smtp.example.test",
    MAIL_FROM: "vb2007.hu <noreply@vb2007.hu>"
};

const mockSendMail: jest.Mock = jest.fn();

jest.mock("nodemailer", () => ({
    __esModule: true,
    default: { createTransport: () => ({ sendMail: mockSendMail }) }
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

const budgetWarnings = (): unknown[][] =>
    (console.warn as jest.Mock).mock.calls.filter(([message]) =>
        String(message).includes("sent today")
    );

describe("Mail Daily Budget Tests", (): void => {
    const mail = { to: "someone@vb2007.hu", ...Emails.registrationCode("123456", 15) };
    const savedEnv: NodeJS.ProcessEnv = { ...process.env };

    const sendTimes = async (send: MailModule["sendMail"], times: number): Promise<void> => {
        for (let sent = 0; sent < times; sent++) {
            await send(mail);
        }
    };

    beforeEach((): void => {
        mockSendMail.mockReset().mockResolvedValue({});
        jest.spyOn(console, "warn").mockImplementation((): void => undefined);
        jest.spyOn(console, "error").mockImplementation((): void => undefined);
        jest.spyOn(console, "log").mockImplementation((): void => undefined);
    });

    afterEach((): void => {
        process.env = { ...savedEnv };
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("should refuse sends over MAIL_DAILY_LIMIT without contacting SMTP", async () => {
        const { sendMail } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "3" });

        await sendTimes(sendMail, 3);

        await expect(sendMail(mail)).rejects.toThrow("daily limit of 3");
        expect(mockSendMail).toHaveBeenCalledTimes(3);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("daily limit of 3"));
    });

    test.each(["", "abc", "0", "-5", "2.5"])(
        "should default to 250 a day when MAIL_DAILY_LIMIT is %p",
        async (limit: string): Promise<void> => {
            const { sendMail } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: limit });

            await sendTimes(sendMail, 250);

            await expect(sendMail(mail)).rejects.toThrow("daily limit of 250");
            expect(mockSendMail).toHaveBeenCalledTimes(250);
        }
    );

    it("should not count mail to reserved domains", async (): Promise<void> => {
        const { sendMail } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "1" });

        await sendMail({ ...mail, to: "someone@local.vb2007.test" });
        await sendMail({ ...mail, to: "someone@local.vb2007.test" });
        await sendMail(mail);

        expect(mockSendMail).toHaveBeenCalledTimes(1);
        await expect(sendMail(mail)).rejects.toThrow("daily limit of 1");
    });

    it("should not count mail while SMTP isn't set", async (): Promise<void> => {
        const { sendMail } = loadMail({ SMTP_HOST: "", MAIL_DAILY_LIMIT: "1" });

        await sendTimes(sendMail, 3);

        expect(mockSendMail).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it("should warn once a day at 80 % of the limit", async (): Promise<void> => {
        const { sendMail } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "10" });

        await sendTimes(sendMail, 7);
        expect(budgetWarnings()).toHaveLength(0);

        await sendMail(mail);
        expect(budgetWarnings()).toEqual([["8 of 10 e-mails sent today (UTC)"]]);

        await sendTimes(sendMail, 2);
        await expect(sendMail(mail)).rejects.toThrow();
        expect(budgetWarnings()).toHaveLength(1);
    });

    it("should reset the count at midnight UTC", async (): Promise<void> => {
        jest.useFakeTimers({ now: new Date("2026-11-02T23:59:00Z") });
        const { sendMail } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "5" });

        await sendTimes(sendMail, 5);
        await expect(sendMail(mail)).rejects.toThrow();

        jest.setSystemTime(new Date("2026-11-03T00:00:01Z"));

        await sendTimes(sendMail, 4);
        expect(mockSendMail).toHaveBeenCalledTimes(9);
        expect(budgetWarnings()).toHaveLength(2);
    });
});
