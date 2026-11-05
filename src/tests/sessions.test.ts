import request from "supertest";
import supertest from "supertest";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { SESSION_MAX_AGE_MS } from "../constants/limits";
import { UserModel } from "../database/users";
import { hashSessionToken } from "../helpers";
import { TestUser, createTestUser, login, sessionTokenOf, storeSession } from "./helpers/testUsers";

const storedSessionOf = async (sessionUser: TestUser) =>
    (
        await UserModel.findById(sessionUser.id)
            .select("+authentication.sessionToken +authentication.sessionExpiresAt")
            .lean()
    ).authentication;

const currentUserRequest = (cookie: string): supertest.Test =>
    request(TestData.apiURL).get("/user").set("Cookie", cookie);

const expectLoggedOut = async (cookie: string): Promise<void> => {
    const response: supertest.Response = await currentUserRequest(cookie).expect(403);

    expect(response.body).toHaveProperty("error", Responses.notLoggedIn);
};

describe("Session API Tests", (): void => {
    describe("a new session", (): void => {
        let sessionUser: TestUser;

        beforeAll(async (): Promise<void> => {
            sessionUser = await createTestUser("sess");
        });

        it("should store only the sha256 of the cookie's token", async (): Promise<void> => {
            const sessionToken: string = sessionTokenOf(sessionUser.cookie);
            const { sessionToken: storedToken } = await storedSessionOf(sessionUser);

            expect(storedToken).not.toBe(sessionToken);
            expect(storedToken).toBe(hashSessionToken(sessionToken));
        });

        it("should expire on the server when the cookie does", async (): Promise<void> => {
            const { sessionExpiresAt } = await storedSessionOf(sessionUser);
            const maxAge: number = Number(sessionUser.cookie.match(/Max-Age=(\d+)/)[1]);

            expect(maxAge * 1000).toBe(SESSION_MAX_AGE_MS);
            expect(sessionExpiresAt.getTime()).toBeGreaterThan(
                Date.now() + SESSION_MAX_AGE_MS - 60 * 1000
            );
            expect(sessionExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SESSION_MAX_AGE_MS);
        });

        it("should authenticate with the cookie", async (): Promise<void> => {
            const response: supertest.Response = await currentUserRequest(
                sessionUser.cookie
            ).expect(200);

            expect(response.body).toHaveProperty("_id", sessionUser.id);
            expect(response.body).not.toHaveProperty("authentication");
        });
    });

    it("should return 403 for an expired session", async (): Promise<void> => {
        const expiredUser: TestUser = await createTestUser("sesexp");
        const cookie: string = await storeSession(expiredUser, new Date(Date.now() - 1000));

        await expectLoggedOut(cookie);
    });

    it("should log out the user's other devices on a new login", async (): Promise<void> => {
        const twoDeviceUser: TestUser = await createTestUser("sesdev");
        const cookie: string = await login(twoDeviceUser.email, twoDeviceUser.password);

        await currentUserRequest(cookie).expect(200);
        await expectLoggedOut(twoDeviceUser.cookie);
    });

    it.each([
        ["without an expiry", { $unset: { "authentication.sessionExpiresAt": 1 } }],
        [
            "with an expiry",
            { $set: { "authentication.sessionExpiresAt": new Date(Date.now() + 60000) } }
        ]
    ])(
        "should return 403 for a legacy plain-text session token %s",
        async (_: string, expiryUpdate: Record<string, unknown>): Promise<void> => {
            const legacyUser: TestUser = await createTestUser("seslgc");

            await UserModel.updateOne(
                { _id: legacyUser.id },
                { $set: { "authentication.sessionToken": sessionTokenOf(legacyUser.cookie) } }
            );
            await UserModel.updateOne({ _id: legacyUser.id }, expiryUpdate);

            await expectLoggedOut(legacyUser.cookie);
        }
    );

    it("should remove the stored session on logout", async (): Promise<void> => {
        const loggedOutUser: TestUser = await createTestUser("seslo");

        await request(TestData.apiURL)
            .post("/auth/logout")
            .set("Cookie", loggedOutUser.cookie)
            .expect(200);

        await expectLoggedOut(loggedOutUser.cookie);

        const storedSession = await storedSessionOf(loggedOutUser);
        expect(storedSession).not.toHaveProperty("sessionToken");
        expect(storedSession).not.toHaveProperty("sessionExpiresAt");
    });

    it("should store the new session's hash on a password change", async (): Promise<void> => {
        const changedUser: TestUser = await createTestUser("seschp");

        const response: supertest.Response = await request(TestData.apiURL)
            .patch("/user/password")
            .set("Cookie", changedUser.cookie)
            .send({
                currentPassword: changedUser.password,
                newPassword: `${changedUser.password}!`
            })
            .expect(200);
        const cookie: string = response.headers["set-cookie"][0];

        await expectLoggedOut(changedUser.cookie);
        await currentUserRequest(cookie).expect(200);
        expect((await storedSessionOf(changedUser)).sessionToken).toBe(
            hashSessionToken(sessionTokenOf(cookie))
        );
    });
});
