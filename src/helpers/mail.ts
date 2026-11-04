import nodemailer, { Transporter } from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export interface Mail {
    to: string;
    subject: string;
    text: string;
}

const smtpHost: string = process.env.SMTP_HOST;
const smtpPort: number = Number(process.env.SMTP_PORT) || 587;
const smtpUser: string = process.env.SMTP_USER;
const smtpPassword: string = process.env.SMTP_PASSWORD;
const mailFrom: string = process.env.MAIL_FROM;

const smtpConnectTimeoutMs: number = 10 * 1000;
const smtpSocketTimeoutMs: number = 20 * 1000;

const defaultDailyLimit: number = 250;

const parseDailyLimit = (value: string | undefined): number => {
    const limit: number = Number(value);
    return Number.isInteger(limit) && limit > 0 ? limit : defaultDailyLimit;
};

const dailyLimit: number = parseDailyLimit(process.env.MAIL_DAILY_LIMIT);
const dailyWarningCount: number = Math.ceil(dailyLimit * 0.8);

//RFC 6761 reserved TLDs can never receive mail
const reservedTlds: string[] = ["test", "example", "invalid", "localhost"];

export const isMailConfigured = (): boolean => Boolean(smtpHost && mailFrom);

export const isReservedEmailDomain = (email: string): boolean =>
    reservedTlds.includes(email.split("@").pop().split(".").pop().toLowerCase());

let transporter: Transporter | null = null;

const getTransporter = (): Transporter =>
    (transporter ??= nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser ? { user: smtpUser, pass: smtpPassword } : undefined,
        connectionTimeout: smtpConnectTimeoutMs,
        greetingTimeout: smtpConnectTimeoutMs,
        socketTimeout: smtpSocketTimeoutMs
    }));

const logUnsentMail = (mail: Mail, reason: string): void => {
    console.warn(`E-mail not sent: ${reason}`);

    if (process.env.NODE_ENV !== "production") {
        console.log(`To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
    }
};

let budgetDay: string = "";
let sentToday: number = 0;
let loggedToday: Set<string> = new Set();

const utcDay = (): string => new Date().toISOString().slice(0, 10);

const startBudgetDay = (): string => {
    const today: string = utcDay();
    if (budgetDay !== today) {
        budgetDay = today;
        sentToday = 0;
        loggedToday = new Set();
    }

    return today;
};

const logOncePerDay = (log: (message: string) => void, message: string): void => {
    if (!loggedToday.has(message)) {
        loggedToday.add(message);
        log(message);
    }
};

const reserveDailySend = (): string => {
    const today: string = startBudgetDay();

    if (sentToday >= dailyLimit) {
        const message: string = `Daily e-mail limit used up: ${dailyLimit} sent today (UTC)`;
        logOncePerDay(console.error, message);
        throw new Error(message);
    }

    sentToday++;

    if (sentToday >= dailyWarningCount) {
        logOncePerDay(
            console.warn,
            `Daily e-mail limit nearly used up: ${dailyWarningCount} of ${dailyLimit} sent today (UTC)`
        );
    }

    return today;
};

const releaseDailySend = (day: string): void => {
    if (budgetDay === day) {
        sentToday--;
    }
};

export const sendMail = async (mail: Mail): Promise<void> => {
    if (!isMailConfigured()) {
        return logUnsentMail(mail, "SMTP_HOST or MAIL_FROM isn't set");
    }

    if (isReservedEmailDomain(mail.to)) {
        return logUnsentMail(mail, "the address is on a reserved domain");
    }

    const day: string = reserveDailySend();

    try {
        await getTransporter().sendMail({ from: mailFrom, ...mail });
    } catch (error) {
        releaseDailySend(day);
        throw error;
    }
};
