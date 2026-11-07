import {
    createEmailCode,
    isEmailCodeMatch,
    hashEmailCode,
    normalizeEmailCode,
    resendWaitSeconds
} from "../helpers/emailCodes";
import { EMAIL_CODE_RESEND_SECONDS } from "../constants/limits";
import { Emails } from "../constants/emails";

type MailModule = typeof import("../helpers/mail");
type Mail = import("../helpers/mail").Mail;

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

jest.mock("dotenv", () => ({
    __esModule: true,
    default: { config: (): void => undefined }
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
                auth: { user: "user", pass: "password" },
                connectionTimeout: 10000,
                greetingTimeout: 10000,
                socketTimeout: 20000
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

    describe("daily budget", (): void => {
        const limitLogs = (log: "warn" | "error"): unknown[][] =>
            (console[log] as jest.Mock).mock.calls.filter(([message]) =>
                String(message).startsWith("Daily e-mail limit")
            );

        const registrationMail = { ...mail, registration: true };

        const sendTimes = async (
            send: MailModule["sendMail"],
            times: number,
            message: Mail = mail
        ): Promise<void> => {
            for (let sent = 0; sent < times; sent++) {
                await send(message);
            }
        };

        beforeEach((): void => {
            jest.spyOn(console, "error").mockImplementation((): void => undefined);
        });

        afterEach((): void => {
            jest.useRealTimers();
        });

        it("should refuse sends over MAIL_DAILY_LIMIT without contacting SMTP", async () => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "3" });

            await sendTimes(send, 3);

            await expect(send(mail)).rejects.toThrow("Daily e-mail limit used up: 3 sent");
            await expect(send(mail)).rejects.toThrow("Daily e-mail limit used up");
            expect(sendMail).toHaveBeenCalledTimes(3);
            expect(limitLogs("error")).toEqual([
                ["Daily e-mail limit used up: 3 sent today (UTC)"]
            ]);
        });

        test.each(["", "abc", "0", "-5", "2.5"])(
            "should default to 250 a day when MAIL_DAILY_LIMIT is %p",
            async (limit: string): Promise<void> => {
                const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: limit });

                await sendTimes(send, 250);

                await expect(send(mail)).rejects.toThrow("250 sent");
                expect(sendMail).toHaveBeenCalledTimes(250);
            }
        );

        it("should not count a send that SMTP rejects", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "2" });
            sendMail.mockRejectedValueOnce(new Error("550 Invalid recipient"));

            await expect(send(mail)).rejects.toThrow("550");
            await sendTimes(send, 2);

            await expect(send(mail)).rejects.toThrow("Daily e-mail limit used up");
            expect(sendMail).toHaveBeenCalledTimes(3);
        });

        it("should not count mail to reserved domains", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "1" });

            await send({ ...mail, to: "someone@local.vb2007.test" });
            await send({ ...mail, to: "someone@local.vb2007.test" });
            await send(mail);

            expect(sendMail).toHaveBeenCalledTimes(1);
            await expect(send(mail)).rejects.toThrow("Daily e-mail limit used up");
        });

        it("should not count mail while SMTP isn't set", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ SMTP_HOST: "", MAIL_DAILY_LIMIT: "1" });

            await sendTimes(send, 3);

            expect(sendMail).not.toHaveBeenCalled();
            expect(console.error).not.toHaveBeenCalled();
        });

        it("should warn once a day at 80 % of the limit", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "10" });

            await sendTimes(send, 7);
            expect(limitLogs("warn")).toHaveLength(0);

            await send(mail);
            expect(limitLogs("warn")).toEqual([
                ["Daily e-mail limit nearly used up: 8 of 10 sent today (UTC)"]
            ]);

            await sendTimes(send, 2);
            await expect(send(mail)).rejects.toThrow();
            expect(limitLogs("warn")).toHaveLength(1);
        });

        it("should keep a fifth of the limit for account mail", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "10" });

            await sendTimes(send, 8, registrationMail);

            await expect(send(registrationMail)).rejects.toThrow(
                "Daily e-mail limit for registration used up: it stops at 8 of 10 sent"
            );
            await sendTimes(send, 2);
            await expect(send(mail)).rejects.toThrow("Daily e-mail limit used up: 10 sent");
            await expect(send(registrationMail)).rejects.toThrow("Daily e-mail limit used up");
            expect(sendMail).toHaveBeenCalledTimes(10);
            expect(sendMail).toHaveBeenNthCalledWith(1, { from: smtpEnv.MAIL_FROM, ...mail });
        });

        it("should allow 200 registration mails of the default 250", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: undefined });

            await sendTimes(send, 200, registrationMail);

            await expect(send(registrationMail)).rejects.toThrow("200 of 250 sent");
            await sendTimes(send, 50);
            await expect(send(mail)).rejects.toThrow("250 sent");
            expect(sendMail).toHaveBeenCalledTimes(250);
        });

        it("should count account mail against the registration share", async () => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "10" });

            await sendTimes(send, 6);
            await sendTimes(send, 2, registrationMail);

            await expect(send(registrationMail)).rejects.toThrow("8 of 10 sent");
            await sendTimes(send, 2);
            expect(sendMail).toHaveBeenCalledTimes(10);
        });

        test.each([
            [0, 1],
            [2, 3],
            [4, 5],
            [4, 6]
        ])(
            "should allow %p registration mails of a daily limit of %p and the rest as account mail",
            async (registrations: number, limit: number): Promise<void> => {
                const { sendMail: send } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: String(limit)
                });

                await sendTimes(send, registrations, registrationMail);
                await expect(send(registrationMail)).rejects.toThrow("for registration used up");

                await sendTimes(send, limit - registrations);
                await expect(send(mail)).rejects.toThrow(
                    `Daily e-mail limit used up: ${limit} sent`
                );
                expect(sendMail).toHaveBeenCalledTimes(limit);
            }
        );

        it("should not count a registration mail that SMTP rejects", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "5" });
            sendMail.mockRejectedValueOnce(new Error("550 Invalid recipient"));

            await expect(send(registrationMail)).rejects.toThrow("550");
            await sendTimes(send, 4, registrationMail);

            await expect(send(registrationMail)).rejects.toThrow("for registration used up");
            expect(sendMail).toHaveBeenCalledTimes(5);
        });

        it("should log the registration share once a day", async (): Promise<void> => {
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "5" });

            await sendTimes(send, 4, registrationMail);
            await expect(send(registrationMail)).rejects.toThrow();
            await expect(send(registrationMail)).rejects.toThrow();
            await send(mail);
            await expect(send(mail)).rejects.toThrow();
            await expect(send(mail)).rejects.toThrow();

            expect(limitLogs("error")).toEqual([
                [
                    "Daily e-mail limit for registration used up: it stops at 4 of 5 sent today (UTC)"
                ],
                ["Daily e-mail limit used up: 5 sent today (UTC)"]
            ]);
        });

        it("should reset the count and logs at midnight UTC", async (): Promise<void> => {
            jest.useFakeTimers({ now: new Date("2026-11-02T23:59:00Z") });
            const { sendMail: send } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: "5" });

            await sendTimes(send, 4, registrationMail);
            await expect(send(registrationMail)).rejects.toThrow();
            await send(mail);
            await expect(send(mail)).rejects.toThrow();

            jest.setSystemTime(new Date("2026-11-03T00:00:01Z"));

            await sendTimes(send, 4, registrationMail);
            await expect(send(registrationMail)).rejects.toThrow();
            await send(mail);
            await expect(send(mail)).rejects.toThrow();
            expect(sendMail).toHaveBeenCalledTimes(10);
            expect(limitLogs("warn")).toHaveLength(2);
            expect(limitLogs("error")).toHaveLength(4);
        });

        it("should read the default budget before any send", (): void => {
            jest.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
            const { readMailBudget } = loadMail({ ...smtpEnv, MAIL_DAILY_LIMIT: undefined });

            expect(readMailBudget()).toEqual({
                sentToday: 0,
                dailyLimit: 250,
                warningAt: 200,
                registrationStopsAt: 200,
                resetsAt: "2026-11-03T00:00:00.000Z"
            });
        });

        it("should read today's sends and roll over at midnight UTC", async () => {
            jest.useFakeTimers({ now: new Date("2026-11-02T23:59:00Z") });
            const { sendMail: send, readMailBudget } = loadMail({
                ...smtpEnv,
                MAIL_DAILY_LIMIT: "10"
            });

            await sendTimes(send, 3);

            expect(readMailBudget()).toEqual({
                sentToday: 3,
                dailyLimit: 10,
                warningAt: 8,
                registrationStopsAt: 8,
                resetsAt: "2026-11-03T00:00:00.000Z"
            });

            jest.setSystemTime(new Date("2026-11-03T00:00:01Z"));

            expect(readMailBudget()).toMatchObject({
                sentToday: 0,
                resetsAt: "2026-11-04T00:00:00.000Z"
            });

            jest.setSystemTime(new Date("2026-11-02T23:59:30Z"));

            expect(readMailBudget().sentToday).toBe(3);
        });

        describe("reserveRegistrationMail", (): void => {
            const reserveTimes = (
                reserve: MailModule["reserveRegistrationMail"],
                times: number
            ): void => {
                for (let reserved = 0; reserved < times; reserved++) {
                    expect(reserve(mail.to)).toEqual({ reserved: true });
                }
            };

            it("should refuse once the registration share is used up", async () => {
                const { sendMail: send, reserveRegistrationMail } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });

                await sendTimes(send, 3, registrationMail);
                expect(reserveRegistrationMail(mail.to)).not.toBeNull();

                expect(reserveRegistrationMail(mail.to)).toBeNull();
                expect(limitLogs("error")).toEqual([
                    [
                        "Daily e-mail limit for registration used up: it stops at 4 of 5 sent today (UTC)"
                    ]
                ]);
            });

            it("should refuse once account mail used up the whole limit", async () => {
                const { sendMail: send, reserveRegistrationMail } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });

                await sendTimes(send, 5);

                expect(reserveRegistrationMail(mail.to)).toBeNull();
                expect(limitLogs("error")).toEqual([
                    ["Daily e-mail limit used up: 5 sent today (UTC)"]
                ]);
            });

            it("should refuse without any send when the registration share is 0", (): void => {
                const { reserveRegistrationMail } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "1"
                });

                expect(reserveRegistrationMail(mail.to)).toBeNull();
            });

            it("should neither refuse nor count while SMTP isn't set", (): void => {
                const { reserveRegistrationMail, readMailBudget } = loadMail({
                    SMTP_HOST: "",
                    MAIL_DAILY_LIMIT: "1"
                });

                expect(reserveRegistrationMail(mail.to)).toEqual({ reserved: false });
                expect(reserveRegistrationMail(mail.to)).toEqual({ reserved: false });
                expect(readMailBudget().sentToday).toBe(0);
                expect(console.error).not.toHaveBeenCalled();
            });

            it("should count a reservation like a sent registration mail", async () => {
                const {
                    sendMail: send,
                    reserveRegistrationMail,
                    readMailBudget
                } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });

                reserveTimes(reserveRegistrationMail, 4);

                expect(readMailBudget().sentToday).toBe(4);
                expect(sendMail).not.toHaveBeenCalled();
                await expect(send(registrationMail)).rejects.toThrow("for registration used up");
                await send(mail);
                await expect(send(mail)).rejects.toThrow("Daily e-mail limit used up: 5 sent");
            });

            it("should use up the budget alike whether the reservation is sent or not", async () => {
                const {
                    sendMail: send,
                    reserveRegistrationMail,
                    readMailBudget
                } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "10"
                });
                const counts: number[] = [];

                await send(registrationMail, reserveRegistrationMail(mail.to));
                counts.push(readMailBudget().sentToday);
                for (let unsent = 0; unsent < 3; unsent++) {
                    reserveRegistrationMail(`${unsent}${mail.to}`);
                    counts.push(readMailBudget().sentToday);
                }

                expect(counts).toEqual([1, 2, 3, 4]);
                expect(sendMail).toHaveBeenCalledTimes(1);
            });

            it("should send against its reservation without counting or checking again", async () => {
                const {
                    sendMail: send,
                    reserveRegistrationMail,
                    readMailBudget
                } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });

                const reservations = [1, 2, 3, 4].map(() => reserveRegistrationMail(mail.to));
                for (const reservation of reservations) {
                    await send(registrationMail, reservation);
                }

                expect(readMailBudget().sentToday).toBe(4);
                expect(sendMail).toHaveBeenCalledTimes(4);
                expect(sendMail).toHaveBeenLastCalledWith({ from: smtpEnv.MAIL_FROM, ...mail });
            });

            it("should keep the reservation of a failed send counted", async () => {
                const {
                    sendMail: send,
                    reserveRegistrationMail,
                    readMailBudget
                } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });
                sendMail.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

                await expect(
                    send(registrationMail, reserveRegistrationMail(mail.to))
                ).rejects.toThrow("ECONNREFUSED");

                expect(readMailBudget().sentToday).toBe(1);
                reserveTimes(reserveRegistrationMail, 3);
                expect(reserveRegistrationMail(mail.to)).toBeNull();
            });

            it("should not count reserved domains, but refuse them alike", async () => {
                const {
                    sendMail: send,
                    reserveRegistrationMail,
                    readMailBudget
                } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });
                const reserved: string = "someone@local.vb2007.test";

                expect(reserveRegistrationMail(reserved)).toEqual({ reserved: false });
                await send({ ...registrationMail, to: reserved });
                expect(readMailBudget().sentToday).toBe(0);

                reserveTimes(reserveRegistrationMail, 4);
                expect(reserveRegistrationMail(reserved)).toBeNull();
                expect(sendMail).not.toHaveBeenCalled();
            });

            it("should warn at 80 % of the limit like sends", (): void => {
                const { reserveRegistrationMail } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "10"
                });

                reserveTimes(reserveRegistrationMail, 7);
                expect(limitLogs("warn")).toHaveLength(0);

                reserveTimes(reserveRegistrationMail, 1);
                expect(limitLogs("warn")).toEqual([
                    ["Daily e-mail limit nearly used up: 8 of 10 sent today (UTC)"]
                ]);
            });

            it("should share the once a day log with refused sends", async (): Promise<void> => {
                const { sendMail: send, reserveRegistrationMail } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });

                reserveTimes(reserveRegistrationMail, 4);
                reserveRegistrationMail(mail.to);
                reserveRegistrationMail(mail.to);
                await expect(send(registrationMail)).rejects.toThrow();

                expect(limitLogs("error")).toEqual([
                    [
                        "Daily e-mail limit for registration used up: it stops at 4 of 5 sent today (UTC)"
                    ]
                ]);
            });

            it("should allow registration mail again after midnight UTC", (): void => {
                jest.useFakeTimers({ now: new Date("2026-11-02T23:59:00Z") });
                const { reserveRegistrationMail, readMailBudget } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });

                reserveTimes(reserveRegistrationMail, 4);
                expect(reserveRegistrationMail(mail.to)).toBeNull();

                jest.setSystemTime(new Date("2026-11-03T00:00:01Z"));

                expect(readMailBudget().sentToday).toBe(0);
                reserveTimes(reserveRegistrationMail, 4);
                expect(reserveRegistrationMail(mail.to)).toBeNull();
                expect(limitLogs("error")).toHaveLength(2);
            });

            it("should count a reservation on the day it was made", async () => {
                jest.useFakeTimers({ now: new Date("2026-11-02T23:59:00Z") });
                const {
                    sendMail: send,
                    reserveRegistrationMail,
                    readMailBudget
                } = loadMail({
                    ...smtpEnv,
                    MAIL_DAILY_LIMIT: "5"
                });
                const reservation = reserveRegistrationMail(mail.to);

                jest.setSystemTime(new Date("2026-11-03T00:00:01Z"));
                await send(mail);
                await send(registrationMail, reservation);

                expect(readMailBudget().sentToday).toBe(1);
                expect(sendMail).toHaveBeenCalledTimes(2);
            });
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
