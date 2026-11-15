import express from "express";
import request from "supertest";
import supertest from "supertest";
import mongoose from "mongoose";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { UserModel } from "../database/users";
import { TestUser, createTestUser, isolatedClientIp } from "./helpers/testUsers";
import { mfaCookieOf } from "./helpers/mfa";
import { mfaCookie, startMfaChallenge } from "../helpers/mfa";

const resetMfa = (id: string, cookie: string = TestData.superuser.cookie): supertest.Test =>
    request(TestData.apiURL).delete(`/admin/users/${id}/mfa`).set("Cookie", cookie);

const loginRequest = (user: TestUser): supertest.Test =>
    request(TestData.apiURL)
        .post("/auth/login")
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ email: user.email, password: user.password });

const mfaUser = async (prefix: string): Promise<TestUser> => {
    const user: TestUser = await createTestUser(prefix);

    await request(TestData.apiURL)
        .put("/user/mfa/email")
        .set("Cookie", user.cookie)
        .set("X-Forwarded-For", isolatedClientIp())
        .send({ password: user.password })
        .expect(200);

    return user;
};

const storedMfa = async (id: string) =>
    (
        await UserModel.collection.findOne(
            { _id: new mongoose.Types.ObjectId(id) },
            {
                projection: {
                    "authentication.mfaEmail": 1,
                    "authentication.mfaChallenge": 1,
                    "authentication.mfaFailures": 1,
                    "authentication.mfaEmailSentAt": 1,
                    "authentication.mfaEmailSends": 1,
                    "authentication.passkeys": 1
                }
            }
        )
    ).authentication;

describe("DELETE /admin/users/:id/mfa", (): void => {
    it("should turn MFA off and end the user's session", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfars");
        await loginRequest(user).expect(202);

        const response: supertest.Response = await resetMfa(user.id).expect(200);
        expect(response.body).toEqual({ message: Responses.Admin.userMfaResetSuccess });

        const details: supertest.Response = await request(TestData.apiURL)
            .get(`/admin/users/${user.id}`)
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);
        expect(details.body.user.mfa).toEqual({ email: false, passkeys: 0 });

        await request(TestData.apiURL).get("/user").set("Cookie", user.cookie).expect(403);

        const login: supertest.Response = await loginRequest(user).expect(200);
        expect(login.body).toEqual({
            message: Responses.Authentication.loginSuccess(user.username)
        });
    });

    it("should end a waiting challenge", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfarc");
        const cookie: string = mfaCookieOf(await loginRequest(user).expect(202));

        await resetMfa(user.id).expect(200);

        const response: supertest.Response = await request(TestData.apiURL)
            .get("/auth/mfa")
            .set("Cookie", cookie)
            .expect(403);
        expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
    });

    it("should clear the MFA counters and keep passkeys", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfark");
        const passkeys = [{ credentialId: `reset-${user.id}` }];
        const counted = { count: 3, since: new Date() };
        await UserModel.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(user.id) },
            {
                $set: {
                    "authentication.mfaFailures": counted,
                    "authentication.mfaEmailSends": counted,
                    "authentication.mfaEmailSentAt": new Date(),
                    "authentication.passkeys": passkeys
                }
            }
        );

        await resetMfa(user.id).expect(200);

        expect(await storedMfa(user.id)).toEqual({ passkeys });
    });

    it("should reject a user who isn't the superuser", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfarf");

        const response: supertest.Response = await resetMfa(user.id, user.cookie).expect(403);
        expect(response.body).toEqual({ error: Responses.notAuthorized });
        expect((await storedMfa(user.id)).mfaEmail).toBe(true);
    });

    it("should answer 404 for an unknown user", async (): Promise<void> => {
        const response: supertest.Response = await resetMfa(
            new mongoose.Types.ObjectId().toString()
        ).expect(404);
        expect(response.body).toEqual({ error: Responses.Admin.userNotFound });
    });

    it("should answer 400 for an invalid id", async (): Promise<void> => {
        await resetMfa("not-an-id").expect(400);
    });

    it("should refuse to reset the superuser", async (): Promise<void> => {
        const response: supertest.Response = await resetMfa(TestData.superuser.id).expect(409);
        expect(response.body).toEqual({ error: Responses.Admin.superuserMfaReset });
        await request(TestData.apiURL)
            .get("/user")
            .set("Cookie", TestData.superuser.cookie)
            .expect(200);
    });
});

describe("an MFA challenge without a method on", (): void => {
    it("should not start once the reset turned every method off", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfarr");
        await resetMfa(user.id).expect(200);

        const res = { cookie: jest.fn() } as unknown as express.Response;
        expect(await startMfaChallenge(res, user.id)).toBe(false);
        expect(res.cookie).not.toHaveBeenCalled();
        expect((await storedMfa(user.id)).mfaChallenge).toBeUndefined();
    });

    it("should be dead on every /auth/mfa endpoint", async (): Promise<void> => {
        const user: TestUser = await mfaUser("mfard");
        const cookie: string = mfaCookieOf(await loginRequest(user).expect(202));
        await UserModel.updateOne({ _id: user.id }, { $unset: { "authentication.mfaEmail": 1 } });

        for (const [method, path, body] of [
            ["get", "/auth/mfa", {}],
            ["post", "/auth/mfa/email", {}],
            ["post", "/auth/mfa/verify", { method: "email", code: "000000" }],
            ["post", "/auth/mfa/verify-link", { token: "x" }]
        ] as const) {
            const response: supertest.Response = await request(TestData.apiURL)
                [method](path)
                .set("Cookie", cookie)
                .set("X-Forwarded-For", isolatedClientIp())
                .send(body)
                .expect(403);
            expect(response.body).toEqual({ error: Responses.Mfa.challengeExpired });
            expect(mfaCookieOf(response)).toBe(`${mfaCookie}=`);
        }
    });
});
