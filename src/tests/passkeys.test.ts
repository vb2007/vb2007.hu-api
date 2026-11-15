import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    GITHUB_REAUTH_MINUTES,
    PASSKEYS_PER_ACCOUNT,
    PASSKEY_NAME_MAX_LENGTH
} from "../constants/limits";
import { UserModel } from "../database/users";
import {
    passkeyLoginCookie,
    passkeyRegistrationCookie,
    passkeyRpId,
    userHandleOf
} from "../helpers/passkeys";
import { sessionCookie } from "../helpers/session";
import { SoftwareAuthenticator, attestedCredential, userPresent } from "./helpers/passkeys";
import {
    TestUser,
    confirmGithub,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    randomHex
} from "./helpers/testUsers";

const cookieOf = (response: supertest.Response, name: string): string | undefined =>
    []
        .concat(response.headers["set-cookie"] ?? [])
        .find((setCookie: string): boolean => setCookie.startsWith(`${name}=`))
        ?.split(";")[0];

const sessionOf = (user: TestUser): string => user.cookie.split(";")[0];

const registrationOptions = (
    user: TestUser,
    body: Record<string, unknown> = { password: user.password }
): supertest.Test =>
    request(TestData.apiURL)
        .post("/user/passkeys/options")
        .set("X-Forwarded-For", isolatedClientIp())
        .set("Cookie", sessionOf(user))
        .send(body);

const finishRegistration = (
    user: TestUser,
    challengeCookie: string,
    body: Record<string, unknown>
): supertest.Test =>
    request(TestData.apiURL)
        .post("/user/passkeys")
        .set("Cookie", [sessionOf(user), challengeCookie])
        .send(body);

const addPasskey = async (
    user: TestUser,
    authenticator: SoftwareAuthenticator,
    status: number
): Promise<supertest.Response> => {
    const options: supertest.Response = await registrationOptions(user).expect(200);

    return finishRegistration(user, cookieOf(options, passkeyRegistrationCookie), {
        name: "Laptop",
        response: authenticator.register(options.body)
    }).expect(status);
};

const listPasskeys = async (user: TestUser) =>
    (
        await request(TestData.apiURL)
            .get("/user/passkeys")
            .set("Cookie", sessionOf(user))
            .expect(200)
    ).body.passkeys;

const deletePasskey = (
    user: TestUser,
    id: string,
    body: Record<string, unknown> = { password: user.password }
): supertest.Test =>
    request(TestData.apiURL)
        .delete(`/user/passkeys/${id}`)
        .set("Cookie", sessionOf(user))
        .send(body);

const renamePasskey = (user: TestUser, id: string, name: unknown): supertest.Test =>
    request(TestData.apiURL)
        .patch(`/user/passkeys/${id}`)
        .set("Cookie", sessionOf(user))
        .send({ name });

interface LoginChallenge {
    options: { challenge: string };
    cookie: string;
}

const loginOptions = async (): Promise<LoginChallenge> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .post("/auth/passkey/options")
        .set("X-Forwarded-For", isolatedClientIp())
        .expect(200);

    return { options: response.body, cookie: cookieOf(response, passkeyLoginCookie) };
};

const passkeyLogin = (cookie: string | undefined, response: unknown): supertest.Test => {
    const login: supertest.Test = request(TestData.apiURL)
        .post("/auth/passkey")
        .set("X-Forwarded-For", isolatedClientIp());

    return (cookie ? login.set("Cookie", cookie) : login).send({ response });
};

const loginWith = async (
    authenticator: SoftwareAuthenticator,
    status: number
): Promise<supertest.Response> => {
    const { options, cookie } = await loginOptions();

    return passkeyLogin(cookie, authenticator.authenticate(options)).expect(status);
};

const storedMfaChallenge = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.mfaChallenge").lean()).authentication
        ?.mfaChallenge;

const expectInvalidPasskey = (response: supertest.Response): void => {
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: Responses.Passkeys.invalidPasskey });
};

describe("Passkey API Tests", (): void => {
    describe("register, list, rename and log in", (): void => {
        let user: TestUser;
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("pk");
        });

        it("should answer registration options for a discoverable, verified passkey", async (): Promise<void> => {
            const response: supertest.Response = await registrationOptions(user).expect(200);
            const setCookie: string = []
                .concat(response.headers["set-cookie"])
                .find((cookie: string): boolean =>
                    cookie.startsWith(`${passkeyRegistrationCookie}=`)
                );

            expect(response.body).toMatchObject({
                rp: { id: passkeyRpId },
                user: { name: user.username },
                attestation: "none",
                excludeCredentials: [],
                authenticatorSelection: {
                    residentKey: "required",
                    requireResidentKey: true,
                    userVerification: "required"
                }
            });
            expect(setCookie.split("; ")).toEqual(
                expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
            );
        });

        it("should store the passkey with its name", async (): Promise<void> => {
            const response: supertest.Response = await addPasskey(user, authenticator, 201);

            expect(response.body).toEqual({
                message: Responses.Passkeys.passkeyAddedSuccess,
                passkey: {
                    id: authenticator.credentialId,
                    name: "Laptop",
                    createdAt: expect.any(String),
                    lastUsedAt: null
                }
            });
        });

        it("should exclude the stored passkey from new registration options", async (): Promise<void> => {
            const response: supertest.Response = await registrationOptions(user).expect(200);

            expect(response.body.excludeCredentials).toEqual([
                {
                    id: authenticator.credentialId,
                    type: "public-key",
                    transports: ["hybrid", "internal"]
                }
            ]);
        });

        it("should list the passkey without key material", async (): Promise<void> => {
            expect(await listPasskeys(user)).toEqual([
                {
                    id: authenticator.credentialId,
                    name: "Laptop",
                    createdAt: expect.any(String),
                    lastUsedAt: null
                }
            ]);
        });

        it("should rename the passkey", async (): Promise<void> => {
            const response: supertest.Response = await renamePasskey(
                user,
                authenticator.credentialId,
                "  Phone  "
            ).expect(200);

            expect(response.body).toEqual({ message: Responses.Passkeys.passkeyRenamedSuccess });
            expect((await listPasskeys(user))[0].name).toBe("Phone");
        });

        it("should log in with the passkey and no e-mail", async (): Promise<void> => {
            const response: supertest.Response = await loginWith(authenticator, 200);

            expect(response.body).toEqual({
                message: Responses.Authentication.loginSuccess(user.username)
            });

            user.cookie = cookieOf(response, sessionCookie);
            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", user.cookie)
                .expect(200);

            expect(userResponse.body).toMatchObject({ _id: user.id, mfa: { passkeys: 1 } });
            expect((await listPasskeys(user))[0].lastUsedAt).toEqual(expect.any(String));

            const stored = await UserModel.findById(user.id)
                .select("+authentication.passkeys")
                .lean();
            expect(stored.authentication.passkeys[0].counter).toBe(1);
        });

        it("should refuse an assertion whose counter went back", async (): Promise<void> => {
            authenticator.counter = 0;

            expectInvalidPasskey(await loginWith(authenticator, 403));
        });
    });

    it("should refuse a registration and a login from another origin", async (): Promise<void> => {
        const user: TestUser = await createTestUser("pkorg");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        const options: supertest.Response = await registrationOptions(user).expect(200);

        const registration: supertest.Response = await finishRegistration(
            user,
            cookieOf(options, passkeyRegistrationCookie),
            {
                name: "Evil",
                response: authenticator.register(options.body, { origin: "https://evil.example" })
            }
        ).expect(400);

        expect(registration.body).toEqual({ error: Responses.Passkeys.invalidRegistration });
        expect(await listPasskeys(user)).toEqual([]);

        await addPasskey(user, authenticator, 201);
        const { options: login, cookie } = await loginOptions();

        expectInvalidPasskey(
            await passkeyLogin(
                cookie,
                authenticator.authenticate(login, { origin: "https://evil.example" })
            )
        );
    });

    it("should use each challenge only once", async (): Promise<void> => {
        const user: TestUser = await createTestUser("pkonce");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        const options: supertest.Response = await registrationOptions(user).expect(200);
        const challengeCookie: string = cookieOf(options, passkeyRegistrationCookie);

        await finishRegistration(user, challengeCookie, {
            name: "Laptop",
            response: authenticator.register(options.body)
        }).expect(201);

        const reused: supertest.Response = await finishRegistration(user, challengeCookie, {
            name: "Again",
            response: new SoftwareAuthenticator().register(options.body)
        }).expect(400);

        expect(reused.body).toEqual({ error: Responses.Passkeys.challengeExpired });

        const { options: login, cookie } = await loginOptions();

        await passkeyLogin(cookie, authenticator.authenticate(login)).expect(200);
        expectInvalidPasskey(await passkeyLogin(cookie, authenticator.authenticate(login)));
    });

    it("should refuse a login without a challenge cookie or with an unknown passkey", async (): Promise<void> => {
        const { options, cookie } = await loginOptions();
        const unknown: SoftwareAuthenticator = new SoftwareAuthenticator();
        unknown.userHandle = "AAAAAAAAAAAAAAAA";

        expectInvalidPasskey(await passkeyLogin(undefined, unknown.authenticate(options)));
        expectInvalidPasskey(await passkeyLogin(cookie, unknown.authenticate(options)));

        const missing: supertest.Response = await passkeyLogin(cookie, "nope").expect(400);
        expect(missing.body).toEqual({ error: Responses.Passkeys.missingResponse });
    });

    describe("reauthentication", (): void => {
        it("should need the password of an account that has one", async (): Promise<void> => {
            const user: TestUser = await createTestUser("pkre");

            const missing: supertest.Response = await registrationOptions(user, {}).expect(400);
            expect(missing.body).toEqual({ error: Responses.Mfa.missingPassword });

            const wrong: supertest.Response = await registrationOptions(user, {
                password: `${user.password}x`
            }).expect(403);
            expect(wrong.body).toEqual({ error: Responses.Authentication.incorrectPassword });

            const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
            await addPasskey(user, authenticator, 201);

            const deleteMissing: supertest.Response = await deletePasskey(
                user,
                authenticator.credentialId,
                {}
            ).expect(400);
            expect(deleteMissing.body).toEqual({ error: Responses.Mfa.missingPassword });

            await deletePasskey(user, authenticator.credentialId, {
                password: `${user.password}x`
            }).expect(403);
            expect(await listPasskeys(user)).toHaveLength(1);
        });

        it("should need a recent GitHub confirmation on a GitHub-only account", async (): Promise<void> => {
            const user: TestUser = await createTestUser("pkgh");
            await linkGithub(user, true);

            const refused: supertest.Response = await registrationOptions(user, {}).expect(403);
            expect(refused.body).toEqual({
                error: Responses.Mfa.githubReauthRequired(GITHUB_REAUTH_MINUTES)
            });

            await confirmGithub(user);
            await registrationOptions(user, {}).expect(200);
        });
    });

    it("should validate the passkey name before using the challenge", async (): Promise<void> => {
        const user: TestUser = await createTestUser("pkname");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        const options: supertest.Response = await registrationOptions(user).expect(200);
        const challengeCookie: string = cookieOf(options, passkeyRegistrationCookie);
        const response = authenticator.register(options.body);

        const blank: supertest.Response = await finishRegistration(user, challengeCookie, {
            name: "  ",
            response
        }).expect(400);
        expect(blank.body).toEqual({ error: Responses.Passkeys.missingName });

        const long: supertest.Response = await finishRegistration(user, challengeCookie, {
            name: "a".repeat(PASSKEY_NAME_MAX_LENGTH + 1),
            response
        }).expect(400);
        expect(long.body).toEqual({ error: Responses.Passkeys.nameTooLong });

        for (const invisible of ["\n", "\t", "\u0085", "\u2028", "\u2029", "\u202e", "\u200b"]) {
            const refused: supertest.Response = await finishRegistration(user, challengeCookie, {
                name: `Work${invisible}laptop`,
                response
            }).expect(400);
            expect(refused.body).toEqual({ error: Responses.Passkeys.nameInvalidCharacters });
        }

        await finishRegistration(user, challengeCookie, {
            name: "a".repeat(PASSKEY_NAME_MAX_LENGTH),
            response
        }).expect(201);
        await renamePasskey(user, authenticator.credentialId, "").expect(400);
        const rtl: supertest.Response = await renamePasskey(
            user,
            authenticator.credentialId,
            "a\u202eb"
        ).expect(400);
        expect(rtl.body).toEqual({ error: Responses.Passkeys.nameInvalidCharacters });
        await renamePasskey(
            user,
            authenticator.credentialId,
            "\u{1F468}\u200d\u{1F4BB} Mac"
        ).expect(200);
    });

    it("should cap the passkeys of an account", async (): Promise<void> => {
        const user: TestUser = await createTestUser("pkcap");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        const options: supertest.Response = await registrationOptions(user).expect(200);

        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: {
                    "authentication.passkeys": Array.from(
                        { length: PASSKEYS_PER_ACCOUNT },
                        (_, index: number) => ({
                            credentialId: `${TestData.runId}-${randomHex(8)}`,
                            publicKey: "AA",
                            counter: 0,
                            name: `Key ${index}`,
                            createdAt: new Date()
                        })
                    )
                }
            }
        );

        const late: supertest.Response = await finishRegistration(
            user,
            cookieOf(options, passkeyRegistrationCookie),
            { name: "Late", response: authenticator.register(options.body) }
        ).expect(409);
        expect(late.body).toEqual({ error: Responses.Passkeys.tooManyPasskeys });

        const refused: supertest.Response = await registrationOptions(user).expect(409);
        expect(refused.body).toEqual({ error: Responses.Passkeys.tooManyPasskeys });
    });

    it("should refuse a credential id another account already has", async (): Promise<void> => {
        const [owner, copier] = await Promise.all([
            createTestUser("pkown"),
            createTestUser("pkcopy")
        ]);
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();

        await addPasskey(owner, authenticator, 201);
        const copied: supertest.Response = await addPasskey(copier, authenticator, 409);

        expect(copied.body).toEqual({ error: Responses.Passkeys.alreadyRegistered });
        expect(await listPasskeys(copier)).toEqual([]);
    });

    it("should delete a passkey so it can't log in any more", async (): Promise<void> => {
        const users: TestUser[] = await Promise.all([
            createTestUser("pkdel"),
            createTestUser("pkdel")
        ]);
        const authenticators: SoftwareAuthenticator[] = users.map(
            (): SoftwareAuthenticator => new SoftwareAuthenticator()
        );

        for (const [index, user] of users.entries()) {
            await addPasskey(user, authenticators[index], 201);

            const response: supertest.Response = await deletePasskey(
                user,
                authenticators[index].credentialId
            ).expect(200);

            expect(response.body).toEqual({ message: Responses.Passkeys.passkeyDeletedSuccess });
            expect(await listPasskeys(user)).toEqual([]);
            expectInvalidPasskey(await loginWith(authenticators[index], 403));
        }

        const userResponse: supertest.Response = await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", sessionOf(users[0]))
            .expect(200);
        expect(userResponse.body.mfa).toEqual({ email: false, passkeys: 0 });

        await deletePasskey(users[0], authenticators[0].credentialId).expect(404);
    });

    it("should not let another account rename or delete a passkey", async (): Promise<void> => {
        const [owner, other] = await Promise.all([
            createTestUser("pkmine"),
            createTestUser("pkoth")
        ]);
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        await addPasskey(owner, authenticator, 201);

        const deleted: supertest.Response = await deletePasskey(
            other,
            authenticator.credentialId
        ).expect(404);
        expect(deleted.body).toEqual({ error: Responses.Passkeys.passkeyNotFound });
        await renamePasskey(other, authenticator.credentialId, "Mine now").expect(404);

        expect(await listPasskeys(owner)).toEqual([expect.objectContaining({ name: "Laptop" })]);
    });

    it("should skip e-mail MFA and drop a pending MFA challenge", async (): Promise<void> => {
        const user: TestUser = await createTestUser("pkmfa");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        await addPasskey(user, authenticator, 201);
        await UserModel.updateOne({ _id: user.id }, { $set: { "authentication.mfaEmail": true } });

        const passwordLogin: supertest.Response = await request(TestData.apiURL)
            .post("/auth/login")
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email: user.email, password: user.password })
            .expect(202);
        expect(passwordLogin.body).toMatchObject({ mfaRequired: true });
        expect(await storedMfaChallenge(user)).toBeDefined();

        const response: supertest.Response = await loginWith(authenticator, 200);

        expect(cookieOf(response, sessionCookie)).toBeDefined();
        expect(await storedMfaChallenge(user)).toBeUndefined();
    });

    it("should refuse a suspended account's passkey login", async (): Promise<void> => {
        const user: TestUser = await createTestUser("pksusp");
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
        await addPasskey(user, authenticator, 201);

        await UserModel.updateOne({ _id: user.id }, { $set: { suspendedAt: new Date() } });

        const response: supertest.Response = await loginWith(authenticator, 403);
        expect(response.body).toEqual({ error: Responses.Authentication.accountSuspended });
        expect(cookieOf(response, sessionCookie)).toBeUndefined();
    });

    describe("security checks", (): void => {
        let owner: TestUser;
        let other: TestUser;
        const authenticator: SoftwareAuthenticator = new SoftwareAuthenticator();

        const expectInvalidRegistration = async (
            user: TestUser,
            register: (options: any) => unknown
        ): Promise<void> => {
            const options: supertest.Response = await registrationOptions(user).expect(200);
            const response: supertest.Response = await finishRegistration(
                user,
                cookieOf(options, passkeyRegistrationCookie),
                { name: "Laptop", response: register(options.body) }
            ).expect(400);

            expect(response.body).toEqual({ error: Responses.Passkeys.invalidRegistration });
        };

        const expectChallengeRefused = (response: supertest.Response): void => {
            expect(response.status).toBe(400);
            expect(response.body).toEqual({ error: Responses.Passkeys.challengeExpired });
        };

        beforeAll(async (): Promise<void> => {
            [owner, other] = await Promise.all([createTestUser("pksec"), createTestUser("pksec")]);
            await addPasskey(owner, authenticator, 201);
        });

        it("should refuse a registration without user verification", async (): Promise<void> => {
            await expectInvalidRegistration(other, (options) =>
                new SoftwareAuthenticator().register(options, {
                    flags: userPresent | attestedCredential
                })
            );
        });

        it("should refuse a registration for another RP ID", async (): Promise<void> => {
            await expectInvalidRegistration(other, (options) =>
                new SoftwareAuthenticator().register(options, { rpId: "evil.example" })
            );
            expect(await listPasskeys(other)).toEqual([]);
        });

        it("should refuse a login without user verification", async (): Promise<void> => {
            const { options, cookie } = await loginOptions();

            expectInvalidPasskey(
                await passkeyLogin(
                    cookie,
                    authenticator.authenticate(options, { flags: userPresent })
                )
            );
        });

        it("should refuse a login for another RP ID", async (): Promise<void> => {
            const { options, cookie } = await loginOptions();

            expectInvalidPasskey(
                await passkeyLogin(
                    cookie,
                    authenticator.authenticate(options, { rpId: "evil.example" })
                )
            );
        });

        it("should refuse a known credential with another account's user handle", async (): Promise<void> => {
            const { options, cookie } = await loginOptions();
            const response = authenticator.authenticate(options);

            expectInvalidPasskey(
                await passkeyLogin(cookie, {
                    ...response,
                    response: { ...response.response, userHandle: userHandleOf(other.id) }
                })
            );
        });

        it("should refuse another account's registration challenge without using it up", async (): Promise<void> => {
            const options: supertest.Response = await registrationOptions(owner).expect(200);
            const challengeCookie: string = cookieOf(options, passkeyRegistrationCookie);
            const newAuthenticator: SoftwareAuthenticator = new SoftwareAuthenticator();
            const body = { name: "Laptop", response: newAuthenticator.register(options.body) };

            expectChallengeRefused(await finishRegistration(other, challengeCookie, body));
            await finishRegistration(owner, challengeCookie, body).expect(201);
        });

        it("should refuse a login challenge for a registration", async (): Promise<void> => {
            const { options, cookie } = await loginOptions();
            const asRegistration: string = cookie.replace(
                `${passkeyLoginCookie}=`,
                `${passkeyRegistrationCookie}=`
            );
            const body = {
                name: "Laptop",
                response: new SoftwareAuthenticator().register({
                    ...options,
                    user: { id: userHandleOf(other.id) }
                })
            };

            expectChallengeRefused(await finishRegistration(other, cookie, body));
            expectChallengeRefused(await finishRegistration(other, asRegistration, body));
            expect(await listPasskeys(other)).toEqual([]);
        });

        it("should set only the login cookie for login options", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .post("/auth/passkey/options")
                .set("X-Forwarded-For", isolatedClientIp())
                .expect(200);

            expect(cookieOf(response, passkeyLoginCookie)).toBeDefined();
            expect(cookieOf(response, passkeyRegistrationCookie)).toBeUndefined();
        });

        it("should still log in with the same passkey when nothing is tampered with", async (): Promise<void> => {
            await loginWith(authenticator, 200);
        });
    });
});
