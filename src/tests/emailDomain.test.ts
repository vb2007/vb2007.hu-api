import dns from "dns";
import { Responses } from "../constants/responses";
import { acceptsMail, emailDomainError, isDisposableDomain } from "../helpers/emailDomain";

const dnsError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const stubDns = (records: {
    mx: dns.MxRecord[] | string;
    a?: string[] | string;
    aaaa?: string[] | string;
}): void => {
    const answer = <T>(value: T[] | string) =>
        typeof value === "string" ? Promise.reject(dnsError(value)) : Promise.resolve(value);

    jest.spyOn(dns.promises.Resolver.prototype, "resolveMx").mockImplementation(() =>
        answer(records.mx)
    );
    jest.spyOn(dns.promises.Resolver.prototype, "resolve4").mockImplementation(
        () => answer(records.a ?? dns.NODATA) as ReturnType<dns.promises.Resolver["resolve4"]>
    );
    jest.spyOn(dns.promises.Resolver.prototype, "resolve6").mockImplementation(
        () => answer(records.aaaa ?? dns.NODATA) as ReturnType<dns.promises.Resolver["resolve6"]>
    );
};

const mx = (exchange: string): dns.MxRecord => ({ exchange, priority: 10 });

describe("E-mail Domain Tests", (): void => {
    const savedNodeEnv: string | undefined = process.env.NODE_ENV;

    afterEach((): void => {
        process.env.NODE_ENV = savedNodeEnv;
        jest.restoreAllMocks();
    });

    describe("isDisposableDomain", (): void => {
        test.each([
            ["mailinator.com", true],
            ["MAILINATOR.com", true],
            ["inbox.mailinator.com", true],
            ["gmail.com", false],
            ["vb2007.hu", false],
            ["privaterelay.appleid.com", false],
            ["com", false]
        ])("should say %s is disposable: %s", (domain: string, disposable: boolean): void => {
            expect(isDisposableDomain(domain)).toBe(disposable);
        });
    });

    describe("acceptsMail", (): void => {
        test.each([
            ["an MX record", { mx: [mx("mx.vb2007.hu")] }, true],
            ["only a null MX", { mx: [mx("")] }, false],
            ["no MX but an A record", { mx: dns.NODATA, a: ["192.0.2.1"] }, true],
            ["no MX but an AAAA record", { mx: dns.NODATA, aaaa: ["2001:db8::1"] }, true],
            ["no MX and no address", { mx: dns.NODATA }, false],
            ["a domain that doesn't exist", { mx: dns.NOTFOUND }, false],
            ["a DNS timeout", { mx: dns.TIMEOUT }, true],
            ["a failing DNS server", { mx: dns.SERVFAIL }, true],
            ["no MX and an address lookup timeout", { mx: dns.NODATA, a: dns.TIMEOUT }, true]
        ])(
            "should handle %s",
            async (_: string, records: Parameters<typeof stubDns>[0], accepts: boolean) => {
                stubDns(records);

                expect(await acceptsMail("domain.example.com")).toBe(accepts);
            }
        );
    });

    describe("emailDomainError", (): void => {
        it("should accept a custom domain with a mail server", async (): Promise<void> => {
            stubDns({ mx: [mx("route1.mx.cloudflare.net")] });

            expect(await emailDomainError("someone@vb2007.hu")).toBeNull();
        });

        it("should reject a disposable domain without a DNS lookup", async (): Promise<void> => {
            stubDns({ mx: [mx("mail.mailinator.com")] });

            expect(await emailDomainError("someone@mailinator.com")).toBe(
                Responses.Authentication.disposableEmail
            );
            expect(dns.promises.Resolver.prototype.resolveMx).not.toHaveBeenCalled();
        });

        it("should reject a domain that can't receive mail", async (): Promise<void> => {
            stubDns({ mx: dns.NOTFOUND });

            expect(await emailDomainError("someone@no-such-domain.com")).toBe(
                Responses.Authentication.undeliverableEmailDomain
            );
        });

        it("should accept reserved test domains outside production", async (): Promise<void> => {
            stubDns({ mx: dns.NOTFOUND });
            process.env.NODE_ENV = "development";

            expect(await emailDomainError("someone@local.vb2007.test")).toBeNull();
            expect(dns.promises.Resolver.prototype.resolveMx).not.toHaveBeenCalled();
        });

        it("should reject reserved test domains in production", async (): Promise<void> => {
            process.env.NODE_ENV = "production";

            expect(await emailDomainError("someone@local.vb2007.test")).toBe(
                Responses.Authentication.undeliverableEmailDomain
            );
        });
    });
});
