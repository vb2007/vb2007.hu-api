import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel, passwordResetScope } from "../database/users";
import {
    EMAIL_CODE_MAX_ATTEMPTS,
    EMAIL_CODE_RESEND_SECONDS,
    createEmailCode,
    hashEmailCode
} from "../helpers/emailCodes";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    randomHex,
    testEmailOf
} from "./helpers/testUsers";

const requestReset = (email: unknown): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/password-reset")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email });

const confirmReset = (body: Record<string, unknown>): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/password-reset/confirm")
        .set("X-Forwarded-For", isolatedClientIp())
        .send(body);

const storedReset = async (user: TestUser) =>
    (await UserModel.findById(user.id).select("+authentication.passwordReset").lean())
        .authentication?.passwordReset;

const setResetCode = async (user: TestUser): Promise<string> => {
    const code: string = createEmailCode();

    await UserModel.updateOne(
        { _id: user.id },
        {
            $set: {
                "authentication.passwordReset.hash": hashEmailCode(
                    passwordResetScope(user.id),
                    code
                )
            }
        }
    );

    return code;
};

const otherCode = (code: string): string => (code === "000000" ? "000001" : "000000");

const loginStatus = async (email: string, password: string): Promise<number> =>
    (await request(TestData.apiURL).post("/auth/login").send({ email, password })).status;

describe("Password Reset API Tests", (): void => {
    describe("POST /auth/password-reset", (): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("pr");
        });

        test.each([
            ["no e-mail", undefined],
            ["an empty e-mail", ""],
            ["a numeric e-mail", 5]
        ])("should answer 400 to %s", async (_: string, email: unknown): Promise<void> => {
            const response: supertest.Response = await requestReset(email).expect(400);

            expect(response.body).toHaveProperty("error", Responses.Authentication.missingEmail);
        });

        it("should answer the same 200 to an address without an account", async (): Promise<void> => {
            const response: supertest.Response = await requestReset(
                testEmailOf(`pr${randomHex(5)}`)
            ).expect(200);

            expect(response.body).toEqual({ message: Responses.Authentication.passwordResetSent });
        });

        it("should store a hashed code for an account, whatever the case", async (): Promise<void> => {
            const response: supertest.Response = await requestReset(
                ` ${user.email.toUpperCase()} `
            ).expect(200);

            expect(response.body).toEqual({ message: Responses.Authentication.passwordResetSent });

            const reset = await storedReset(user);
            expect(reset).toMatchObject({ attempts: 0 });
            expect(reset.hash).toMatch(/^[0-9a-f]{64}$/);
            expect(reset.expiresAt.getTime() - reset.sentAt.getTime()).toBe(30 * 60 * 1000);
        });

        it("should keep the code within the cooldown and answer the same 200", async (): Promise<void> => {
            const { hash } = await storedReset(user);

            const response: supertest.Response = await requestReset(user.email).expect(200);

            expect(response.body).toEqual({ message: Responses.Authentication.passwordResetSent });
            expect((await storedReset(user)).hash).toBe(hash);
        });

        it("should replace the code after the cooldown", async (): Promise<void> => {
            const { hash } = await storedReset(user);
            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: {
                        "authentication.passwordReset.sentAt": new Date(
                            Date.now() - EMAIL_CODE_RESEND_SECONDS * 1000
                        )
                    }
                }
            );

            await requestReset(user.email).expect(200);

            expect((await storedReset(user)).hash).not.toBe(hash);
        });

        it("should not show the code in GET /user", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", user.cookie)
                .expect(200);

            expect(JSON.stringify(response.body)).not.toContain("passwordReset");
        });
    });

    describe("POST /auth/password-reset/confirm", (): void => {
        const newPassword: string = randomHex(12);

        const userWithCode = async (): Promise<[TestUser, string]> => {
            const user: TestUser = await createTestUser("prc");
            await requestReset(user.email).expect(200);
            return [user, await setResetCode(user)];
        };

        test.each([
            ["nothing", {}],
            ["no code", { email: "x", newPassword: "password123" }],
            ["no new password", { email: "x", code: "123456" }],
            ["a numeric code", { email: "x", code: 123456, newPassword: "password123" }]
        ])("should answer 400 to %s", async (_: string, body: object): Promise<void> => {
            const response: supertest.Response = await confirmReset({
                ...body,
                ...("email" in body ? { email: testEmailOf(`prc${randomHex(5)}`) } : {})
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.missingPasswordResetFields
            );
        });

        it("should answer 400 to a too short password without using up a try", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code,
                newPassword: "short"
            }).expect(400);

            expect(response.body).toHaveProperty(
                "error",
                Responses.Authentication.passwordTooShort
            );
            expect(await storedReset(user)).toMatchObject({ attempts: 0 });
        });

        it("should set the new password, end every session and use up the code", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const response: supertest.Response = await confirmReset({
                email: user.email.toUpperCase(),
                code: `${code.slice(0, 3)} ${code.slice(3)}`,
                newPassword
            }).expect(200);

            expect(response.body).toEqual({
                message: Responses.Authentication.passwordResetSuccess
            });
            expect(response.headers["set-cookie"]).toBeUndefined();
            expect(await storedReset(user)).toBeUndefined();
            expect(await loginStatus(user.email, user.password)).toBe(403);
            expect(await loginStatus(user.email, newPassword)).toBe(200);
            await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(403);

            await confirmReset({ email: user.email, code, newPassword }).expect(400);
        });

        it("should answer 400 to a wrong code and still take the right one", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code: otherCode(code),
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
            expect(await storedReset(user)).toMatchObject({ attempts: 1 });
            expect(await loginStatus(user.email, user.password)).toBe(200);

            await confirmReset({ email: user.email, code, newPassword }).expect(200);
        });

        it(`should void the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong attempts`, async (): Promise<void> => {
            const [user, code] = await userWithCode();

            for (let attempt = 0; attempt < EMAIL_CODE_MAX_ATTEMPTS; attempt++) {
                await confirmReset({
                    email: user.email,
                    code: otherCode(code),
                    newPassword
                }).expect(400);
            }

            await confirmReset({ email: user.email, code, newPassword }).expect(400);
            expect(await loginStatus(user.email, user.password)).toBe(200);
        });

        it("should answer 400 to an expired code", async (): Promise<void> => {
            const [user, code] = await userWithCode();
            await UserModel.updateOne(
                { _id: user.id },
                { $set: { "authentication.passwordReset.expiresAt": new Date(Date.now() - 1000) } }
            );

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code,
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should answer 400 to an address without a code", async (): Promise<void> => {
            const user: TestUser = await createTestUser("prc");

            const response: supertest.Response = await confirmReset({
                email: user.email,
                code: "123456",
                newPassword
            }).expect(400);

            expect(response.body).toHaveProperty("error", Responses.EmailCodes.invalidCode);
        });

        it("should accept the code only once from parallel requests", async (): Promise<void> => {
            const [user, code] = await userWithCode();

            const responses: supertest.Response[] = await Promise.all(
                Array.from({ length: 4 }, (_: unknown, index: number): supertest.Test =>
                    confirmReset({ email: user.email, code, newPassword: `${newPassword}${index}` })
                )
            );

            const accepted: number[] = responses
                .map((response: supertest.Response, index: number): number =>
                    response.status === 200 ? index : -1
                )
                .filter((index: number): boolean => index >= 0);

            expect(accepted).toHaveLength(1);
            expect(await loginStatus(user.email, `${newPassword}${accepted[0]}`)).toBe(200);
        });

        it("should give a GitHub-only account a password and confirm its e-mail", async (): Promise<void> => {
            const [user, code] = await userWithCode();
            await UserModel.updateOne(
                { _id: user.id },
                {
                    $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin: "gh" },
                    $unset: {
                        "authentication.password": 1,
                        "authentication.salt": 1,
                        "authentication.emailVerifiedAt": 1
                    }
                }
            );
            expect(await loginStatus(user.email, user.password)).toBe(403);

            await confirmReset({ email: user.email, code, newPassword }).expect(200);

            const loginResponse: supertest.Response = await request(TestData.apiURL)
                .post("/auth/login")
                .send({ email: user.email, password: newPassword })
                .expect(200);
            const userResponse: supertest.Response = await request(TestData.apiURL)
                .get("/user")
                .set("Cookie", loginResponse.headers["set-cookie"][0])
                .expect(200);

            expect(userResponse.body).toMatchObject({
                hasPassword: true,
                emailVerified: true,
                githubLogin: "gh"
            });
        });
    });
});
