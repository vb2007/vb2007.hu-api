import { db } from "../prisma/db";
import { isDuplicateKeyOn, isObjectId, newObjectId } from "../helpers/prisma";
import { randomHex } from "./helpers/testUsers";

describe("Prisma client", (): void => {
    const challengeId: string = `prisma-test-${process.env.TEST_RUN_ID}-${randomHex(8)}`;

    afterAll(async (): Promise<void> => {
        await db.orm.passkeychallenges.where({ id: challengeId }).deleteAndCount();
        await db.close();
    });

    it("should write, read and delete a document", async (): Promise<void> => {
        const userId: string = newObjectId();
        const expiresAt: Date = new Date(Date.now() + 60 * 1000);

        await db.orm.passkeychallenges.create({
            id: challengeId,
            challenge: "challenge",
            userId,
            expiresAt
        });

        expect(await db.orm.passkeychallenges.where({ id: challengeId }).first()).toEqual({
            id: challengeId,
            challenge: "challenge",
            userId,
            expiresAt
        });

        const error: unknown = await db.orm.passkeychallenges
            .create({ id: challengeId, challenge: "again", userId: null, expiresAt })
            .catch((error: unknown): unknown => error);

        expect(isDuplicateKeyOn(error, "_id")).toBe(true);
        expect(await db.orm.passkeychallenges.where({ id: challengeId }).deleteAndCount()).toBe(1);
        expect(await db.orm.passkeychallenges.where({ id: challengeId }).first()).toBeNull();
    });

    it("should only accept 24 hex character ids", (): void => {
        expect(isObjectId(newObjectId())).toBe(true);
        expect(isObjectId("6afaa6bd1bfbf30e7e8e794G")).toBe(false);
        expect(isObjectId("aaaaaaaaaaaa")).toBe(false);
        expect(isObjectId(42)).toBe(false);
    });
});
