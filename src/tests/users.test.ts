import request from "supertest";
import supertest from "supertest";
import fs from "fs";
import path from "path";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import {
    UserModel,
    createUser,
    deleteGithubVerifiedUser,
    emailChangeScope
} from "../database/users";
import { PastebinModel } from "../database/pastebin";
import { ShortUrlModel } from "../database/shortUrls";
import { UserUploadsModel } from "../database/userUploads";
import { isSuperuserEmail } from "../helpers";
import { isDuplicateKeyError } from "../helpers/mongoose";
import {
    EMAIL_CODE_MAX_ATTEMPTS,
    EMAIL_CODE_RESEND_SECONDS,
    createEmailCode,
    hashEmailCode
} from "../helpers/emailCodes";
import {
    TestUser,
    addPasteAndShortUrl,
    confirmGithub,
    createTestUser,
    isolatedClientIp,
    linkGithub,
    login,
    randomHex,
    sessionTokenOf,
    storeSession,
    testEmailOf,
    testEmailOfLength
} from "./helpers/testUsers";

describe("Users API Tests", (): void => {
    describe("GET /user", (): void => {
        let other: TestUser;
        let passwordUser: TestUser;
        let githubUser: TestUser;

        const githubLogin: string = `gh-${randomHex(5)}`;
        const userFields: string[] = [
            "_id",
            "createdAt",
            "email",
            "emailVerified",
            "hasPassword",
            "isSuperuser",
            "pendingEmail",
            "username"
        ];

        beforeAll(async (): Promise<void> => {
            other = await createTestUser();
            passwordUser = await createTestUser();
            githubUser = await createTestUser("gh");

            await UserModel.updateOne(
                { _id: githubUser.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin },
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                }
            );
        }, 25000);

        it("should mark the superuser as isSuperuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", TestData.superuser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", TestData.superuser.email);
            expect(response.body).toHaveProperty("isSuperuser", true);
        });

        it("should not mark another user as isSuperuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", other.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("email", other.email);
            expect(response.body).toHaveProperty("isSuperuser", false);
        });

        it("should return hasPassword without the credentials for a password user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", passwordUser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("hasPassword", true);
            expect(response.body).not.toHaveProperty("authentication");
        });

        it("should return githubLogin and no password for a GitHub-only user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", githubUser.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("username", githubUser.username);
            expect(response.body).toHaveProperty("githubLogin", githubLogin);
            expect(response.body).toHaveProperty("hasPassword", false);
            expect(response.body).not.toHaveProperty("authentication");
        });

        it("should return only the user fields for a password user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", passwordUser.cookie)
                .expect(200);

            expect(Object.keys(response.body).sort()).toEqual(userFields);
        });

        it("should add only the GitHub fields for a GitHub user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", githubUser.cookie)
                .expect(200);

            expect(Object.keys(response.body).sort()).toEqual(
                [...userFields, "githubId", "githubLogin"].sort()
            );
        });
    });

    describe("GET /users", (): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser();
        }, 25000);

        it("should not list users to a logged-in user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/users")
                .set("Cookie", user.cookie)
                .expect(404);

            expect(response.body).toEqual({ error: Responses.routeNotFound });
            expect(response.text).not.toContain(user.email);
            expect(response.text).not.toContain(TestData.superuser.email);
            expect(Array.isArray(response.body)).toBe(false);
        });
    });

    describe("PATCH /users/:id", (): void => {
        let user: TestUser;
        let renamed: TestUser;
        let padded: TestUser;
        let other: TestUser;
        let recased: TestUser;

        const currentUsername = async (cookie: string): Promise<string> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            return response.body.username;
        };

        beforeAll(async (): Promise<void> => {
            [user, renamed, padded, other, recased] = await Promise.all([
                createTestUser("pu"),
                createTestUser("pu"),
                createTestUser("pu"),
                createTestUser("pu"),
                createTestUser("pu")
            ]);
        }, 25000);

        it("should update the user's username", async (): Promise<void> => {
            const username: string = `t${randomHex(5)}`;

            const response: supertest.Response = await request(TestData.apiURL)
                .patch(`/users/${renamed.id}`)
                .set("Cookie", renamed.cookie)
                .send({ username })
                .expect(200);

            expect(response.body).toHaveProperty("message", Responses.Users.userUpdatedSuccess);
            expect(await currentUsername(renamed.cookie)).toBe(username);
        });

        it("should let the user keep their own username", async (): Promise<void> => {
            await request(TestData.apiURL)
                .patch(`/users/${user.id}`)
                .set("Cookie", user.cookie)
                .send({ username: user.username })
                .expect(200);

            expect(await currentUsername(user.cookie)).toBe(user.username);
        });

        it("should store the username trimmed", async (): Promise<void> => {
            await request(TestData.apiURL)
                .patch(`/users/${padded.id}`)
                .set("Cookie", padded.cookie)
                .send({ username: ` ${padded.username} ` })
                .expect(200);

            expect(await currentUsername(padded.cookie)).toBe(padded.username);
        });

        it("should let the user change only the case of their own username", async (): Promise<void> => {
            const username: string = recased.username.toUpperCase();

            await request(TestData.apiURL)
                .patch(`/users/${recased.id}`)
                .set("Cookie", recased.cookie)
                .send({ username })
                .expect(200);

            expect(await currentUsername(recased.cookie)).toBe(username);
        });

        test.each([
            ["the same", (): string => other.username],
            ["a whitespace-padded", (): string => ` ${other.username} `],
            ["a differently cased", (): string => other.username.toUpperCase()]
        ])(
            "should not let the user take %s username as another user",
            async (description: string, username: () => string): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .patch(`/users/${user.id}`)
                    .set("Cookie", user.cookie)
                    .send({ username: username() })
                    .expect(409);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.usernameTaken
                );
                expect(await currentUsername(user.cookie)).toBe(user.username);
            }
        );

        test.each([
            ["no username", {}, Responses.Users.missingUsername],
            ["a null username", { username: null }, Responses.Users.missingUsername],
            ["an empty username", { username: "" }, Responses.Users.missingUsername],
            ["an object username", { username: { x: 1 } }, Responses.Users.missingUsername],
            ["an array username", { username: ["ab"] }, Responses.Users.missingUsername],
            ["a too short username", { username: "a" }, Responses.Authentication.usernameTooShort],
            [
                "a whitespace-padded too short username",
                { username: "  a  " },
                Responses.Authentication.usernameTooShort
            ],
            [
                "a too long username",
                { username: `t${randomHex(8)}` },
                Responses.Authentication.usernameTooLong
            ]
        ])(
            "should reject %s",
            async (description: string, body: object, error: string): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .patch(`/users/${user.id}`)
                    .set("Cookie", user.cookie)
                    .send(body)
                    .expect(400);

                expect(response.body).toHaveProperty("error", error);
                expect(await currentUsername(user.cookie)).toBe(user.username);
            }
        );
    });

    describe("PATCH /user/email", (): void => {
        let user: TestUser;
        let other: TestUser;
        let changingUser: TestUser;
        let sameEmailUser: TestUser;
        let githubUser: TestUser;
        let longEmailUser: TestUser;
        let tagEmailUser: TestUser;
        let longLocalPartUser: TestUser;
        let conflictUser: TestUser;
        let superuserEmailUser: TestUser;
        let racers: TestUser[];

        const unusedEmail: string = testEmailOf(`em${randomHex(5)}`);

        const changeEmail = (cookie: string, body: object): supertest.Test =>
            request(TestData.apiURL)
                .patch("/user/email")
                .set("Cookie", cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const confirmEmail = (cookie: string, body: object): supertest.Test =>
            request(TestData.apiURL)
                .post("/user/email/confirm")
                .set("Cookie", cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const storedChange = async (changer: TestUser) =>
            (await UserModel.findById(changer.id).select("+authentication.emailChange").lean())
                .authentication?.emailChange;

        const setEmailChangeCode = async (changer: TestUser): Promise<string> => {
            const code: string = createEmailCode();
            const { email } = await storedChange(changer);

            await UserModel.updateOne(
                { _id: changer.id },
                {
                    $set: {
                        "authentication.emailChange.hash": hashEmailCode(
                            emailChangeScope(changer.id, email),
                            code
                        )
                    }
                }
            );

            return code;
        };

        const changeAndConfirm = async (changer: TestUser, email: string): Promise<void> => {
            await changeEmail(changer.cookie, { email, password: changer.password }).expect(202);
            await confirmEmail(changer.cookie, { code: await setEmailChangeCode(changer) }).expect(
                200
            );
        };

        const currentUser = async (cookie: string) =>
            (await request(TestData.apiURL).get("/user").set("Cookie", cookie).expect(200)).body;

        const currentEmail = async (cookie: string): Promise<string> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", cookie)
                .expect(200);

            return response.body.email;
        };

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("em");
            other = await createTestUser("em");
            changingUser = await createTestUser("em");
            sameEmailUser = await createTestUser("em");
            githubUser = await createTestUser("emgh");
            longEmailUser = await createTestUser("em");
            tagEmailUser = await createTestUser("em");
            longLocalPartUser = await createTestUser("em");
            conflictUser = await createTestUser("em");
            superuserEmailUser = await createTestUser("em");
            racers = [await createTestUser("emr"), await createTestUser("emr")];

            await UserModel.updateOne(
                { _id: githubUser.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}` },
                    $unset: { "authentication.password": 1, "authentication.salt": 1 }
                }
            );
        }, 25000);

        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .patch("/user/email")
                .send({ email: testEmailOf(`em${randomHex(5)}`), password: "password" })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it("should mail a code to the new address and keep the old one until it's confirmed", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`em${randomHex(5)}`);

            const response: supertest.Response = await changeEmail(changingUser.cookie, {
                email: ` ${newEmail.toUpperCase()} `,
                password: changingUser.password
            }).expect(202);

            expect(response.body).toEqual({
                message: Responses.Users.emailChangeCodeSent(newEmail)
            });
            expect(await currentUser(changingUser.cookie)).toMatchObject({
                email: changingUser.email,
                pendingEmail: newEmail
            });
            expect(await storedChange(changingUser)).toMatchObject({
                email: newEmail,
                attempts: 0
            });
        });

        it("should change the e-mail with the code and log in with it", async (): Promise<void> => {
            const newEmail: string = (await storedChange(changingUser)).email;

            const response: supertest.Response = await confirmEmail(changingUser.cookie, {
                code: await setEmailChangeCode(changingUser)
            }).expect(200);

            expect(response.body).toEqual({ message: Responses.Users.emailUpdatedSuccess });
            expect(await currentUser(changingUser.cookie)).toMatchObject({
                email: newEmail,
                emailVerified: true,
                pendingEmail: null
            });
            expect(await storedChange(changingUser)).toBeUndefined();
            await expect(login(newEmail, changingUser.password)).resolves.toMatch(/VB-AUTH/);

            await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: changingUser.email, password: changingUser.password })
                .expect(403);
        });

        it("should accept the current e-mail in another case and keep it", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(sameEmailUser.cookie, {
                email: sameEmailUser.email.toUpperCase(),
                password: sameEmailUser.password
            }).expect(200);

            expect(response.body).toEqual({ message: Responses.Users.emailUpdatedSuccess });
            expect(await currentEmail(sameEmailUser.cookie)).toBe(sameEmailUser.email);
        });

        it.each([
            ["no body", {}],
            ["no password", { email: unusedEmail }],
            ["no e-mail", { password: "password" }],
            ["an empty e-mail", { email: "", password: "password" }],
            ["a non-string e-mail", { email: [unusedEmail], password: "password" }],
            ["a non-string password", { email: unusedEmail, password: 123 }]
        ])("should return 400 for %s", async (_: string, body: object): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, body).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingEmailPassword
            );
        });

        it("should return 400 for a malformed e-mail", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: "not-an-email",
                password: user.password
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.invalidEmailFormat
            );
        });

        it.each([
            ["two @ signs", `x@@${TestData.emailDomain}`],
            ["a leading dot in the domain", `x@.${TestData.emailDomain}`],
            ["a trailing dot in the domain", `x@${TestData.emailDomain}.`],
            ["two dots in a row in the domain", `x@${TestData.emailDomain.replace(".", "..")}`],
            ["over 254 characters", testEmailOfLength(255)],
            ["a trailing comment", "x@mailinator.com(c)"],
            ["a display name", "n<x@mailinator.com>"],
            ["a second address after a comma", "x@mailinator.com,y"],
            ["a comma in the local part", "a,b@evil.com"],
            ["a quoted local part", `"x"@${TestData.emailDomain}`],
            ["two dots in a row in the local part", `x..y@${TestData.emailDomain}`],
            ["a leading dot in the local part", `.x@${TestData.emailDomain}`],
            ["a trailing dot in the local part", `x.@${TestData.emailDomain}`],
            ["a leading hyphen in a domain label", `x@-${TestData.emailDomain}`],
            ["a domain label over 63 characters", `x@${"a".repeat(64)}.${TestData.emailDomain}`],
            ["a local part over 64 characters", testEmailOf(randomHex(5).padEnd(65, "a"))]
        ])(
            "should return 400 for an e-mail with %s",
            async (_: string, email: string): Promise<void> => {
                const response: supertest.Response = await changeEmail(user.cookie, {
                    email,
                    password: user.password
                }).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.invalidEmailFormat
                );
                expect(await currentEmail(user.cookie)).toBe(user.email);
            }
        );

        it("should change the e-mail to a 254 character one", async (): Promise<void> => {
            const newEmail: string = testEmailOfLength(254);

            await changeAndConfirm(longEmailUser, newEmail);

            expect(await currentEmail(longEmailUser.cookie)).toBe(newEmail);
        });

        it("should change the e-mail to one with a 64 character local part", async (): Promise<void> => {
            const newEmail: string = testEmailOf(longLocalPartUser.username.padEnd(64, "a"));

            await changeAndConfirm(longLocalPartUser, newEmail);

            expect(await currentEmail(longLocalPartUser.cookie)).toBe(newEmail);
        });

        it("should change the e-mail to a +tag one", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`${tagEmailUser.username}+tag`);

            await changeAndConfirm(tagEmailUser, newEmail);

            expect(await currentEmail(tagEmailUser.cookie)).toBe(newEmail);
        });

        it("should return 403 for a wrong password", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: testEmailOf(`em${randomHex(5)}`),
                password: `${user.password}x`
            }).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
            expect(await currentEmail(user.cookie)).toBe(user.email);
        });

        it.each([
            ["another user's e-mail", (): string => other.email.toUpperCase()],
            ["the superuser's e-mail", (): string => TestData.superuser.email]
        ])(
            "should check the password before %s",
            async (_: string, email: () => string): Promise<void> => {
                const response: supertest.Response = await changeEmail(user.cookie, {
                    email: email(),
                    password: `${user.password}x`
                }).expect(403);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.incorrectPassword
                );
                expect(await currentEmail(user.cookie)).toBe(user.email);
            }
        );

        it("should answer another user's e-mail in another case like a new one and report the conflict at confirm", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(conflictUser.cookie, {
                email: other.email.toUpperCase(),
                password: conflictUser.password
            }).expect(202);

            expect(response.body).toEqual({
                message: Responses.Users.emailChangeCodeSent(other.email)
            });
            expect(await currentUser(conflictUser.cookie)).toMatchObject({
                email: conflictUser.email,
                pendingEmail: other.email
            });

            const confirmResponse: supertest.Response = await confirmEmail(conflictUser.cookie, {
                code: await setEmailChangeCode(conflictUser)
            }).expect(409);

            expect(confirmResponse.body).toHaveProperty(
                "error",
                Responses.Authentication.emailAlreadyExists
            );
            expect(await storedChange(conflictUser)).toBeUndefined();
            expect(await currentEmail(conflictUser.cookie)).toBe(conflictUser.email);
            expect(await currentEmail(other.cookie)).toBe(other.email);
        });

        it("should give one of two concurrent confirmations of the same e-mail a 409", async (): Promise<void> => {
            const newEmail: string = testEmailOf(`em${randomHex(5)}`);

            for (const racer of racers) {
                await changeEmail(racer.cookie, {
                    email: newEmail,
                    password: racer.password
                }).expect(202);
            }

            const codes: string[] = await Promise.all(racers.map(setEmailChangeCode));
            const responses: supertest.Response[] = await Promise.all(
                racers.map((racer: TestUser, index: number) =>
                    confirmEmail(racer.cookie, { code: codes[index] })
                )
            );

            expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
            expect(
                await Promise.all(racers.map((racer: TestUser) => currentEmail(racer.cookie)))
            ).toContain(newEmail);
        });

        it("should answer the superuser's e-mail like a new one and refuse it at confirm", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(superuserEmailUser.cookie, {
                email: TestData.superuser.email.toUpperCase(),
                password: superuserEmailUser.password
            }).expect(202);

            expect(response.body).toEqual({
                message: Responses.Users.emailChangeCodeSent(TestData.superuser.email)
            });

            const confirmResponse: supertest.Response = await confirmEmail(
                superuserEmailUser.cookie,
                { code: await setEmailChangeCode(superuserEmailUser) }
            ).expect(403);

            expect(confirmResponse.body).toHaveProperty(
                "error",
                Responses.Users.emailReservedForSuperuser
            );
            expect(await storedChange(superuserEmailUser)).toBeUndefined();
            expect(await currentEmail(superuserEmailUser.cookie)).toBe(superuserEmailUser.email);
            expect(await currentEmail(TestData.superuser.cookie)).toBe(TestData.superuser.email);
        });

        it("should return 403 when the superuser changes its e-mail", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(TestData.superuser.cookie, {
                email: testEmailOf(`em${randomHex(5)}`),
                password: "password"
            }).expect(403);

            expect(response.body).toHaveProperty("error", Responses.Users.superuserEmailChange);
            expect(await currentEmail(TestData.superuser.cookie)).toBe(TestData.superuser.email);
        });

        it("should return 409 for an account without a password", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(githubUser.cookie, {
                email: testEmailOf(`em${randomHex(5)}`),
                password: "password"
            }).expect(409);

            expect(response.body).toHaveProperty("error", Responses.Users.noPasswordToChangeEmail);
            expect(await currentEmail(githubUser.cookie)).toBe(githubUser.email);
        });

        it("should return 400 for a disposable address", async (): Promise<void> => {
            const response: supertest.Response = await changeEmail(user.cookie, {
                email: `em${randomHex(5)}@mailinator.com`,
                password: user.password
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.disposableEmail);
        });

        describe("with a code waiting", (): void => {
            let waitingUser: TestUser;
            let takenUser: TestUser;
            let triedUser: TestUser;

            beforeAll(async (): Promise<void> => {
                [waitingUser, takenUser, triedUser] = await Promise.all([
                    createTestUser("emc"),
                    createTestUser("emc"),
                    createTestUser("emc")
                ]);
            }, 25000);

            const startChange = async (changer: TestUser): Promise<string> => {
                const email: string = testEmailOf(`emc${randomHex(5)}`);
                await changeEmail(changer.cookie, { email, password: changer.password }).expect(
                    202
                );
                return email;
            };

            const allowResend = (changer: TestUser): Promise<unknown> =>
                UserModel.updateOne(
                    { _id: changer.id },
                    {
                        $set: {
                            "authentication.emailChange.sentAt": new Date(
                                Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000
                            )
                        }
                    }
                );

            it("should answer 429 to another change within the cooldown", async (): Promise<void> => {
                await startChange(waitingUser);

                const response: supertest.Response = await changeEmail(waitingUser.cookie, {
                    email: testEmailOf(`emc${randomHex(5)}`),
                    password: waitingUser.password
                }).expect(429);

                expect(response.body.retryAfter).toBeGreaterThan(0);
                expect(response.body.retryAfter).toBeLessThanOrEqual(EMAIL_CODE_RESEND_SECONDS);
            });

            it("should replace the waiting address after the cooldown", async (): Promise<void> => {
                await allowResend(waitingUser);
                const email: string = await startChange(waitingUser);

                expect((await currentUser(waitingUser.cookie)).pendingEmail).toBe(email);
                await confirmEmail(waitingUser.cookie, {
                    code: await setEmailChangeCode(waitingUser)
                }).expect(200);
                expect(await currentEmail(waitingUser.cookie)).toBe(email);
            });

            it("should return 403 when not logged in", async (): Promise<void> => {
                const response: supertest.Response = await request(TestData.apiURL)
                    .post("/user/email/confirm")
                    .send({ code: "123456" })
                    .expect(403);

                expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
            });

            test.each([
                ["no code", {}],
                ["a numeric code", { code: 123456 }]
            ])("should return 400 for %s", async (_: string, body: object): Promise<void> => {
                const response: supertest.Response = await confirmEmail(
                    triedUser.cookie,
                    body
                ).expect(400);

                expect(response.body).toHaveProperty("error", Responses.Users.missingCode);
            });

            it("should return 400 without a waiting change", async (): Promise<void> => {
                const response: supertest.Response = await confirmEmail(triedUser.cookie, {
                    code: "123456"
                }).expect(400);

                expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            });

            it(`should void the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong attempts`, async (): Promise<void> => {
                await startChange(triedUser);
                const code: string = await setEmailChangeCode(triedUser);
                const wrongCode: string = code === "000000" ? "000001" : "000000";

                for (let attempt = 0; attempt < EMAIL_CODE_MAX_ATTEMPTS; attempt++) {
                    await confirmEmail(triedUser.cookie, { code: wrongCode }).expect(400);
                }

                await confirmEmail(triedUser.cookie, { code }).expect(400);
                expect(await currentEmail(triedUser.cookie)).toBe(triedUser.email);
            });

            it("should return 400 for an expired code", async (): Promise<void> => {
                await allowResend(triedUser);
                await startChange(triedUser);
                const code: string = await setEmailChangeCode(triedUser);
                await UserModel.updateOne(
                    { _id: triedUser.id },
                    {
                        $set: {
                            "authentication.emailChange.expiresAt": new Date(Date.now() - 1000)
                        }
                    }
                );

                await confirmEmail(triedUser.cookie, { code }).expect(400);
                expect(await currentUser(triedUser.cookie)).toMatchObject({
                    email: triedUser.email,
                    pendingEmail: null
                });
            });

            it("should return 409 when the address was taken meanwhile", async (): Promise<void> => {
                const email: string = await startChange(takenUser);
                const code: string = await setEmailChangeCode(takenUser);
                await createTestUser("emc").then((taker: TestUser) =>
                    UserModel.updateOne({ _id: taker.id }, { $set: { email } })
                );

                const response: supertest.Response = await confirmEmail(takenUser.cookie, {
                    code
                }).expect(409);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Authentication.emailAlreadyExists
                );
                expect(await storedChange(takenUser)).toBeUndefined();
                expect(await currentEmail(takenUser.cookie)).toBe(takenUser.email);
            });
        });
    });

    describe("DELETE /user", (): void => {
        let passwordUser: TestUser;
        let githubUser: TestUser;
        let other: TestUser;
        let deletedUser: TestUser;
        let deletedGithubUser: TestUser;
        let unconfirmedUser: TestUser;
        let staleUser: TestUser;
        let futureUser: TestUser;
        let rotatedUser: TestUser;
        let concurrentUser: TestUser;
        let deletedUserUploadId: string;

        const testPng: Buffer = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "base64"
        );

        const deleteAccount = (cookie: string, body: object): supertest.Test =>
            request(TestData.apiURL)
                .delete("/user")
                .set("Cookie", cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body);

        const minutesFromNow = (minutes: number): Date =>
            new Date(Date.now() + minutes * 60 * 1000);

        const uploadFolderOf = (user: TestUser): string =>
            path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id);

        const addContent = async (user: TestUser): Promise<string> => {
            await addPasteAndShortUrl(user.cookie);

            const response: supertest.Response = await request(TestData.apiURL)
                .post("/upload")
                .set("Cookie", user.cookie)
                .attach("file", testPng, "deleted-account.png")
                .expect(201);

            return response.body.upload.id;
        };

        const expectStillThere = async (user: TestUser): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", user.cookie)
                .expect(200);

            expect(response.body).toHaveProperty("_id", user.id);
        };

        const expectContentGone = async (user: TestUser): Promise<void> => {
            expect(await PastebinModel.countDocuments({ addedBy: user.id })).toBe(0);
            expect(await ShortUrlModel.countDocuments({ addedBy: user.id })).toBe(0);
            expect(await UserUploadsModel.countDocuments({ uploadedBy: user.id })).toBe(0);
            expect(fs.existsSync(uploadFolderOf(user))).toBe(false);
        };

        const expectContentKept = async (user: TestUser): Promise<void> => {
            expect(await PastebinModel.countDocuments({ addedBy: user.id })).toBe(1);
            expect(await ShortUrlModel.countDocuments({ addedBy: user.id })).toBe(1);
            expect(await UserUploadsModel.countDocuments({ uploadedBy: user.id })).toBe(1);
            expect(fs.existsSync(uploadFolderOf(user))).toBe(true);
        };

        const expectDeleted = async (
            user: TestUser,
            response: supertest.Response
        ): Promise<void> => {
            expect(response.body).toEqual({ message: Responses.Users.userDeletedSuccess });
            expect(response.headers["set-cookie"]).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/^VB-AUTH=;.*Expires=Thu, 01 Jan 1970/)
                ])
            );
            expect(await UserModel.exists({ _id: user.id })).toBeNull();

            const sessionResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", user.cookie)
                .expect(403);

            expect(sessionResponse.body).toHaveProperty("error", Responses.notLoggedIn);
        };

        beforeAll(async (): Promise<void> => {
            [
                passwordUser,
                githubUser,
                other,
                deletedUser,
                deletedGithubUser,
                unconfirmedUser,
                staleUser,
                futureUser,
                rotatedUser,
                concurrentUser
            ] = await Promise.all([
                createTestUser("del"),
                createTestUser("delgh"),
                createTestUser("del"),
                createTestUser("del"),
                createTestUser("delgh"),
                createTestUser("delgh"),
                createTestUser("delgh"),
                createTestUser("delgh"),
                createTestUser("delgh"),
                createTestUser("delgh")
            ]);

            await Promise.all(
                [
                    githubUser,
                    deletedGithubUser,
                    unconfirmedUser,
                    staleUser,
                    futureUser,
                    rotatedUser,
                    concurrentUser
                ].map((user: TestUser): Promise<string> => linkGithub(user, true))
            );

            await Promise.all([
                confirmGithub(githubUser),
                confirmGithub(deletedGithubUser),
                confirmGithub(staleUser, minutesFromNow(-11)),
                confirmGithub(futureUser, minutesFromNow(5)),
                confirmGithub(rotatedUser),
                confirmGithub(concurrentUser)
            ]);

            [deletedUserUploadId] = await Promise.all(
                [
                    deletedUser,
                    deletedGithubUser,
                    unconfirmedUser,
                    staleUser,
                    futureUser,
                    rotatedUser,
                    concurrentUser
                ].map((user: TestUser): Promise<string> => addContent(user))
            );

            await storeSession(rotatedUser);
        }, 25000);

        it("should return 403 when not logged in", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete("/user")
                .send({ password: "password" })
                .expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
        });

        it.each([
            ["no body", {}],
            ["an empty password", { password: "" }],
            ["a non-string password", { password: ["password"] }],
            ["a username instead of the password", { username: "username" }]
        ])(
            "should return 400 for %s on an account with a password",
            async (_: string, body: object): Promise<void> => {
                const response: supertest.Response = await deleteAccount(
                    passwordUser.cookie,
                    body
                ).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Users.missingDeletePassword
                );
                await expectStillThere(passwordUser);
            }
        );

        it("should return 403 for a wrong password", async (): Promise<void> => {
            const response: supertest.Response = await deleteAccount(passwordUser.cookie, {
                password: `${passwordUser.password}x`
            }).expect(403);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.incorrectPassword
            );
            await expectStillThere(passwordUser);
        });

        it.each([
            ["no body", {}],
            ["an empty username", { username: "" }],
            ["a non-string username", { username: ["username"] }],
            ["a password instead of the username", { password: "password" }]
        ])(
            "should return 400 for %s on an account without a password",
            async (_: string, body: object): Promise<void> => {
                const response: supertest.Response = await deleteAccount(
                    githubUser.cookie,
                    body
                ).expect(400);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Users.missingDeleteUsername
                );
                await expectStillThere(githubUser);
            }
        );

        it.each([
            ["another user's username", (): string => other.username],
            ["the username in another case", (): string => githubUser.username.toUpperCase()]
        ])(
            "should return 403 for %s on a GitHub-confirmed account without a password",
            async (_: string, username: () => string): Promise<void> => {
                const response: supertest.Response = await deleteAccount(githubUser.cookie, {
                    username: username()
                }).expect(403);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Users.incorrectDeleteUsername
                );
                await expectStillThere(githubUser);
            }
        );

        it.each([
            ["without a GitHub confirmation", (): TestUser => unconfirmedUser],
            ["with a GitHub confirmation older than 10 minutes", (): TestUser => staleUser],
            ["with a GitHub confirmation in the future", (): TestUser => futureUser]
        ])(
            "should return 403 and keep everything for an account without a password %s",
            async (_: string, user: () => TestUser): Promise<void> => {
                const response: supertest.Response = await deleteAccount(user().cookie, {
                    username: user().username
                }).expect(403);

                expect(response.body).toHaveProperty(
                    "error",
                    Responses.Users.githubReauthRequiredToDelete(10)
                );
                await expectStillThere(user());
                await expectContentKept(user());
            }
        );

        it("should refuse a stale cookie from a session that ended after the GitHub confirmation and keep everything", async (): Promise<void> => {
            const response: supertest.Response = await deleteAccount(rotatedUser.cookie, {
                username: rotatedUser.username
            }).expect(403);

            expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
            expect(await UserModel.exists({ _id: rotatedUser.id })).not.toBeNull();
            await expectContentKept(rotatedUser);
        });

        it("should no longer delete through DELETE /users/:id", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .delete(`/users/${passwordUser.id}`)
                .set("Cookie", passwordUser.cookie)
                .send({ password: passwordUser.password })
                .expect(404);

            expect(response.body).toEqual({ error: Responses.routeNotFound });
            await expectStillThere(passwordUser);
        });

        it("should delete an account with a password and everything it owns", async (): Promise<void> => {
            expect(fs.existsSync(uploadFolderOf(deletedUser))).toBe(true);

            const response: supertest.Response = await deleteAccount(deletedUser.cookie, {
                password: deletedUser.password
            }).expect(200);

            await expectDeleted(deletedUser, response);
            await expectContentGone(deletedUser);
            expect(await UserUploadsModel.exists({ _id: deletedUserUploadId })).toBeNull();
        });

        it("should delete an account without a password and everything it owns", async (): Promise<void> => {
            expect(fs.existsSync(uploadFolderOf(deletedGithubUser))).toBe(true);

            const response: supertest.Response = await deleteAccount(deletedGithubUser.cookie, {
                username: deletedGithubUser.username
            }).expect(200);

            await expectDeleted(deletedGithubUser, response);
            await expectContentGone(deletedGithubUser);
        });

        it("should let only one of several concurrent calls delete an account without a password", async (): Promise<void> => {
            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 5 }, (): supertest.Test =>
                    deleteAccount(concurrentUser.cookie, { username: concurrentUser.username })
                )
            );

            const statuses: number[] = responses.map(
                (response: supertest.Response): number => response.status
            );
            expect(statuses.filter((status: number): boolean => status === 200)).toHaveLength(1);

            for (const response of responses.filter(
                (response: supertest.Response): boolean => response.status !== 200
            )) {
                expect(response.status).toBe(403);
                expect([
                    Responses.notLoggedIn,
                    Responses.Users.githubReauthRequiredToDelete(10)
                ]).toContain(response.body.error);
            }

            expect(await UserModel.exists({ _id: concurrentUser.id })).toBeNull();
            await expectContentGone(concurrentUser);
        });

        describe("deleteGithubVerifiedUser", (): void => {
            let wrongTokenUser: TestUser;
            let withPasswordUser: TestUser;
            let futureConfirmedUser: TestUser;
            let matchingUser: TestUser;

            const deleteVerified = async (
                user: TestUser,
                sessionToken: string
            ): Promise<number> => {
                const { deletedCount } = await deleteGithubVerifiedUser(
                    user.id,
                    sessionToken,
                    minutesFromNow(-10)
                );

                return deletedCount;
            };

            beforeAll(async (): Promise<void> => {
                [wrongTokenUser, withPasswordUser, futureConfirmedUser, matchingUser] =
                    await Promise.all([
                        createTestUser("dgvu"),
                        createTestUser("dgvu"),
                        createTestUser("dgvu"),
                        createTestUser("dgvu")
                    ]);

                await Promise.all([
                    linkGithub(wrongTokenUser, true),
                    linkGithub(withPasswordUser),
                    linkGithub(futureConfirmedUser, true),
                    linkGithub(matchingUser, true)
                ]);

                await Promise.all([
                    confirmGithub(wrongTokenUser),
                    confirmGithub(withPasswordUser),
                    confirmGithub(futureConfirmedUser, minutesFromNow(5)),
                    confirmGithub(matchingUser)
                ]);
            }, 25000);

            it("should delete nothing with another session token", async (): Promise<void> => {
                expect(await deleteVerified(wrongTokenUser, randomHex(32))).toBe(0);
                expect(await UserModel.exists({ _id: wrongTokenUser.id })).not.toBeNull();
            });

            it("should delete nothing for an account with a password", async (): Promise<void> => {
                expect(
                    await deleteVerified(withPasswordUser, sessionTokenOf(withPasswordUser.cookie))
                ).toBe(0);
                expect(await UserModel.exists({ _id: withPasswordUser.id })).not.toBeNull();
            });

            it("should delete nothing for a GitHub confirmation in the future", async (): Promise<void> => {
                expect(
                    await deleteVerified(
                        futureConfirmedUser,
                        sessionTokenOf(futureConfirmedUser.cookie)
                    )
                ).toBe(0);
                expect(await UserModel.exists({ _id: futureConfirmedUser.id })).not.toBeNull();
            });

            it("should delete a GitHub-only account confirmed from its own session", async (): Promise<void> => {
                expect(
                    await deleteVerified(matchingUser, sessionTokenOf(matchingUser.cookie))
                ).toBe(1);
                expect(await UserModel.exists({ _id: matchingUser.id })).toBeNull();
            });
        });
    });

    describe("isDuplicateKeyError", (): void => {
        let user: TestUser;
        let other: TestUser;

        beforeAll(async (): Promise<void> => {
            [user, other] = await Promise.all([createTestUser("dk"), createTestUser("dk")]);
        }, 25000);

        it("should match a unique index violation", async (): Promise<void> => {
            const error: unknown = await UserModel.updateOne(
                { _id: user.id },
                { $set: { username: other.username } }
            ).then(
                (): null => null,
                (error: unknown): unknown => error
            );

            expect(isDuplicateKeyError(error)).toBe(true);
        });

        it("should not match other errors", (): void => {
            expect(isDuplicateKeyError(new Error())).toBe(false);
            expect(isDuplicateKeyError(null)).toBe(false);
            expect(isDuplicateKeyError(undefined)).toBe(false);
        });
    });

    describe("UserModel e-mail validation", (): void => {
        let storedUser: TestUser;

        beforeAll(async (): Promise<void> => {
            const user: TestUser = await createTestUser("ev");
            const email: string = `${user.username}@@${TestData.emailDomain}`;

            await UserModel.updateOne({ _id: user.id }, { $set: { email } });
            storedUser = { ...user, email };
        }, 25000);

        it("should still log in a stored user whose e-mail the old rule allowed", async (): Promise<void> => {
            expect(await login(storedUser.email, storedUser.password)).toMatch(/^VB-AUTH=/);
        });

        it("should reject changing a stored user's e-mail to an invalid one", async (): Promise<void> => {
            const user = await UserModel.findById(storedUser.id);
            user.email = `x${storedUser.email}`;

            await expect(user.validate()).rejects.toHaveProperty(
                "errors.email.kind",
                "user defined"
            );
        });

        it.each([
            ["two @ signs", `us${randomHex(5)}@@${TestData.emailDomain}`],
            [
                "two dots in a row in the domain",
                testEmailOf(`us${randomHex(5)}`, TestData.emailDomain.replace(".", ".."))
            ],
            ["300 characters", testEmailOfLength(300)]
        ])(
            "should not store an e-mail with %s",
            async (_: string, email: string): Promise<void> => {
                await expect(
                    createUser({ username: `us${randomHex(5)}`, email })
                ).rejects.toHaveProperty("errors.email.kind", "user defined");
                expect(await UserModel.countDocuments({ email })).toBe(0);
            }
        );
    });

    describe("isSuperuserEmail", (): void => {
        const originalSuperuserEmail: string | undefined = process.env.SUPERUSER_EMAIL;

        afterEach((): void => {
            if (originalSuperuserEmail === undefined) {
                delete process.env.SUPERUSER_EMAIL;
            } else {
                process.env.SUPERUSER_EMAIL = originalSuperuserEmail;
            }
        });

        it("should match the configured e-mail", (): void => {
            process.env.SUPERUSER_EMAIL = "admin@example.com";

            expect(isSuperuserEmail("admin@example.com")).toBe(true);
            expect(isSuperuserEmail("other@example.com")).toBe(false);
        });

        it("should ignore case", (): void => {
            process.env.SUPERUSER_EMAIL = "Admin@Example.com";

            expect(isSuperuserEmail("aDMIN@example.COM")).toBe(true);
        });

        it("should ignore surrounding whitespace", (): void => {
            process.env.SUPERUSER_EMAIL = "  admin@example.com\t";

            expect(isSuperuserEmail(" admin@example.com  ")).toBe(true);
        });

        it("should match nobody when the env is empty", (): void => {
            process.env.SUPERUSER_EMAIL = "  ";

            expect(isSuperuserEmail("")).toBe(false);
            expect(isSuperuserEmail("  ")).toBe(false);
            expect(isSuperuserEmail("admin@example.com")).toBe(false);
        });

        it("should match nobody when the env is unset", (): void => {
            delete process.env.SUPERUSER_EMAIL;

            expect(isSuperuserEmail("")).toBe(false);
            expect(isSuperuserEmail("admin@example.com")).toBe(false);
        });
    });
});
