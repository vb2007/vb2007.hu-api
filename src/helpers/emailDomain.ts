import dns from "dns";
import { disposableEmailBlocklistSet } from "disposable-email-domains-js";

import { Responses } from "../constants/responses";
import { isReservedEmailDomain } from "./mail";

const dnsTimeoutMs: number = 5000;
const missingRecordCodes: string[] = [dns.NOTFOUND, dns.NODATA];

const disposableDomains: Set<string> = disposableEmailBlocklistSet();
const resolver = new dns.promises.Resolver({ timeout: dnsTimeoutMs, tries: 2 });

const domainAndParents = (domain: string): string[] => {
    const labels: string[] = domain.split(".");
    return labels.slice(0, -1).map((_: string, index: number) => labels.slice(index).join("."));
};

export const isDisposableDomain = (domain: string): boolean =>
    domainAndParents(domain.toLowerCase()).some((name: string) => disposableDomains.has(name));

const isMissingRecord = (error: unknown): boolean =>
    missingRecordCodes.includes((error as NodeJS.ErrnoException)?.code);

const hasAddress = async (domain: string): Promise<boolean> => {
    const lookups = await Promise.allSettled([
        resolver.resolve4(domain),
        resolver.resolve6(domain)
    ]);

    return lookups.some(
        (lookup) =>
            (lookup.status === "fulfilled" && lookup.value.length > 0) ||
            (lookup.status === "rejected" && !isMissingRecord(lookup.reason))
    );
};

//RFC 5321: without MX records mail goes to the A/AAAA address; RFC 7505: a lone "." MX means no mail
export const acceptsMail = async (domain: string): Promise<boolean> => {
    try {
        const records: dns.MxRecord[] = await resolver.resolveMx(domain);
        return records.some((record: dns.MxRecord) => record.exchange !== "");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === dns.NODATA) {
            return hasAddress(domain);
        }

        return !isMissingRecord(error);
    }
};

export const emailDomainError = async (email: string): Promise<string | null> => {
    const domain: string = email.split("@").pop();

    if (isReservedEmailDomain(email)) {
        return process.env.NODE_ENV === "production"
            ? Responses.Authentication.undeliverableEmailDomain
            : null;
    }

    if (isDisposableDomain(domain)) {
        return Responses.Authentication.disposableEmail;
    }

    if (!(await acceptsMail(domain))) {
        return Responses.Authentication.undeliverableEmailDomain;
    }

    return null;
};
