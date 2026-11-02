import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel, emailChangeScope, passwordResetScope } from "../database/users";
import { createEmailCode, hashEmailCode } from "../helpers/emailCodes";
import {
    TestUser,
    createTestUser,
    isolatedClientIp,
    randomHex,
    testEmailOf
} from "./helpers/testUsers";

const currentUser = async (cookie: string) =>
    (await request(TestData.apiURL).get("/user").set("Cookie", cookie).expect(200)).body;

const expectLoggedOut = async (cookie: string): Promise<void> => {
    const response: supertest.Response = await request(TestData.apiURL)
        .get("/user")
        .set("Cookie", cookie)
        .expect(403);

    expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
};

const sessionCookieOf = (response: supertest.Response): string => {
    const cookie: string = response.headers["set-cookie"][0];
    expect(cookie).toMatch(/^VB-AUTH=/);
    return cookie;
};

const loginRequest = (email: string, password: string): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email, password });

const plantCode = async (userId: string, field: string, scope: string): Promise<string> => {
    const code: string = createEmailCode();

    await UserModel.updateOne(
        { _id: userId },
        { $set: { [`authentication.${field}.hash`]: hashEmailCode(scope, code) } }
    );

    return code;
};

describe("Account round trip: GitHub account to password", (): void => {
    let user: TestUser;
    let githubLogin: string;
    let cookie: string;
    let email: string;
    let previousEmail: string;
    let username: string;
    let password: string;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("rt");
        githubLogin = `gh-${randomHex(5)}`;

        await UserModel.updateOne(
            { _id: user.id },
            {
                $set: { githubId: `${TestData.runId}-${randomHex(8)}`, githubLogin },
                $unset: { "authentication.password": 1, "authentication.salt": 1 }
            }
        );

        ({ cookie, email, username } = user);
    });

    it("should start as a GitHub-only account without a password login", async (): Promise<void> => {
        expect(await currentUser(cookie)).toMatchObject({
            _id: user.id,
            email,
            githubLogin,
            hasPassword: false,
            emailVerified: true,
            pendingEmail: null
        });

        const response: supertest.Response = await loginRequest(email, user.password).expect(403);

        expect(response.body).toHaveProperty("error", Responses.Authentication.noPasswordSet);
    });

    it("should set a password after confirming with GitHub", async (): Promise<void> => {
        await UserModel.updateOne(
            { _id: user.id },
            { $set: { "authentication.githubVerifiedAt": new Date() } }
        );
        password = randomHex(12);

        const response: supertest.Response = await request(TestData.apiURL)
            .post("/user/password")
            .set("Cookie", cookie)
            .send({ password })
            .expect(200);

        expect(response.body).toEqual({ message: Responses.Users.passwordSetSuccess });
        await expectLoggedOut(cookie);
        cookie = sessionCookieOf(response);

        expect(await currentUser(cookie)).toMatchObject({
            _id: user.id,
            githubLogin,
            hasPassword: true
        });
    });

    it("should change the e-mail once the new address is confirmed", async (): Promise<void> => {
        const newEmail: string = testEmailOf(`rt${randomHex(5)}`);

        const changeResponse: supertest.Response = await request(TestData.apiURL)
            .patch("/user/email")
            .set("Cookie", cookie)
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email: newEmail, password })
            .expect(202);

        expect(changeResponse.body).toEqual({
            message: Responses.Users.emailChangeCodeSent(newEmail)
        });
        expect(await currentUser(cookie)).toMatchObject({ email, pendingEmail: newEmail });

        const code: string = await plantCode(
            user.id,
            "emailChange",
            emailChangeScope(user.id, newEmail)
        );

        const confirmResponse: supertest.Response = await request(TestData.apiURL)
            .post("/user/email/confirm")
            .set("Cookie", cookie)
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ code })
            .expect(200);

        expect(confirmResponse.body).toEqual({ message: Responses.Users.emailUpdatedSuccess });
        expect(await currentUser(cookie)).toMatchObject({
            email: newEmail,
            githubLogin,
            hasPassword: true,
            emailVerified: true,
            pendingEmail: null
        });

        previousEmail = email;
        email = newEmail;
    });

    it("should change the password and the username", async (): Promise<void> => {
        const newPassword: string = randomHex(12);

        const passwordResponse: supertest.Response = await request(TestData.apiURL)
            .patch("/user/password")
            .set("Cookie", cookie)
            .send({ currentPassword: password, newPassword })
            .expect(200);

        expect(passwordResponse.body).toEqual({
            message: Responses.Users.passwordChangedSuccess
        });
        await expectLoggedOut(cookie);
        cookie = sessionCookieOf(passwordResponse);
        password = newPassword;

        username = `rt${randomHex(5)}`;

        const usernameResponse: supertest.Response = await request(TestData.apiURL)
            .patch(`/users/${user.id}`)
            .set("Cookie", cookie)
            .send({ username })
            .expect(200);

        expect(usernameResponse.body).toEqual({ message: Responses.Users.userUpdatedSuccess });
        expect(await currentUser(cookie)).toMatchObject({
            username,
            email,
            githubLogin,
            hasPassword: true
        });
    });

    it("should unlink GitHub", async (): Promise<void> => {
        const response: supertest.Response = await request(TestData.apiURL)
            .delete("/auth/github/link")
            .set("Cookie", cookie)
            .send({ password })
            .expect(200);

        expect(response.body).toEqual({ message: Responses.GithubOauth.githubUnlinkedSuccess });

        const body = await currentUser(cookie);
        expect(body).toMatchObject({ username, email, hasPassword: true, pendingEmail: null });
        expect(body).not.toHaveProperty("githubLogin");
        expect(body).not.toHaveProperty("githubId");

        const storedUser = await UserModel.findById(user.id).lean();
        expect(Object.keys(storedUser)).not.toContain("githubId");
        expect(Object.keys(storedUser)).not.toContain("githubLogin");
    });

    it("should log in with the new e-mail and the password only", async (): Promise<void> => {
        const response: supertest.Response = await loginRequest(email, password).expect(200);

        expect(response.body).toEqual({
            message: Responses.Authentication.loginSuccess(username)
        });
        cookie = sessionCookieOf(response);
        expect(await currentUser(cookie)).toMatchObject({ _id: user.id, hasPassword: true });

        const oldEmailResponse: supertest.Response = await loginRequest(
            previousEmail,
            password
        ).expect(404);

        expect(oldEmailResponse.body).toHaveProperty(
            "error",
            Responses.Authentication.userNotFound
        );
    });

    it("should reset a forgotten password", async (): Promise<void> => {
        const newPassword: string = randomHex(12);

        const resetResponse: supertest.Response = await request(TestData.apiURL)
            .post("/auth/password-reset")
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email })
            .expect(200);

        expect(resetResponse.body).toEqual({
            message: Responses.Authentication.passwordResetSent
        });

        const code: string = await plantCode(user.id, "passwordReset", passwordResetScope(user.id));

        const confirmResponse: supertest.Response = await request(TestData.apiURL)
            .post("/auth/password-reset/confirm")
            .set("X-Forwarded-For", isolatedClientIp())
            .send({ email, code, newPassword })
            .expect(200);

        expect(confirmResponse.body).toEqual({
            message: Responses.Authentication.passwordResetSuccess
        });
        await expectLoggedOut(cookie);

        const oldPasswordResponse: supertest.Response = await loginRequest(email, password).expect(
            403
        );

        expect(oldPasswordResponse.body).toHaveProperty(
            "error",
            Responses.Authentication.incorrectPassword
        );

        password = newPassword;
        cookie = sessionCookieOf(await loginRequest(email, password).expect(200));

        const body = await currentUser(cookie);
        expect(body).toMatchObject({ _id: user.id, username, email, hasPassword: true });
        expect(body).not.toHaveProperty("githubLogin");
    });

    it("should delete the account with its password", async (): Promise<void> => {
        const response: supertest.Response = await request(TestData.apiURL)
            .delete("/user")
            .set("Cookie", cookie)
            .send({ password })
            .expect(200);

        expect(response.body).toEqual({ message: Responses.Users.userDeletedSuccess });
        expect(response.headers["set-cookie"]).toEqual(
            expect.arrayContaining([expect.stringMatching(/^VB-AUTH=;.*Expires=Thu, 01 Jan 1970/)])
        );
        expect(await UserModel.exists({ _id: user.id })).toBeNull();
        await expectLoggedOut(cookie);

        const loginResponse: supertest.Response = await loginRequest(email, password).expect(404);

        expect(loginResponse.body).toHaveProperty("error", Responses.Authentication.userNotFound);
    });
});
