import nodemailer from "nodemailer";
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

//RFC 6761 reserved TLDs can never receive mail
const reservedTlds: string[] = [".test", ".example", ".invalid", ".localhost"];

export const isMailConfigured = (): boolean => Boolean(smtpHost && mailFrom);

export const isReservedEmailDomain = (email: string): boolean =>
    reservedTlds.some((tld: string): boolean => email.toLowerCase().endsWith(tld));

let transporter: nodemailer.Transporter | null = null;

const getTransporter = (): nodemailer.Transporter =>
    (transporter ??= nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser ? { user: smtpUser, pass: smtpPassword } : undefined
    }));

const logUnsentMail = (mail: Mail, reason: string): void => {
    console.warn(`E-mail not sent: ${reason}`);

    if (process.env.NODE_ENV !== "production") {
        console.log(`To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
    }
};

export const sendMail = async (mail: Mail): Promise<void> => {
    if (!isMailConfigured()) {
        return logUnsentMail(mail, "SMTP_HOST or MAIL_FROM isn't set");
    }

    if (isReservedEmailDomain(mail.to)) {
        return logUnsentMail(mail, "the address is on a reserved domain");
    }

    await getTransporter().sendMail({ from: mailFrom, ...mail });
};
