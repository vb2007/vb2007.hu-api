import mongoose from "mongoose";
import dotenv from "dotenv";
import { ObjectId } from "@prisma/orm-mongo/bson";
import { MongoExistsExpr, MongoFieldFilter, MongoOrExpr } from "@prisma/orm-mongo/query-ast";
import { MongoParamRef } from "@prisma/orm-mongo/value";
import { allOf } from "../../helpers/prisma";
import { TestData, testEmailDomainSuffix } from "../../constants/testData";
import {
    TestUser,
    deleteTestUsers,
    emailsEndingWith,
    randomHex,
    registerTestUser
} from "../helpers/testUsers";

dotenv.config();

const staleTestDataAgeMs: number = 1000 * 60 * 60 * 24;
const runCollectionName: RegExp = /^(?:migrations|users|shorturls|useruploads)-test-(.+)$/;

const dropStaleRunCollections = async (staleBeforeId: mongoose.Types.ObjectId): Promise<void> => {
    const db = mongoose.connection.db;

    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
        const runId: string | undefined = name.match(runCollectionName)?.[1];

        if (!runId || runId === process.env.TEST_RUN_ID) {
            continue;
        }

        const collection = db.collection(name);
        const isStale: boolean =
            (await collection.countDocuments({}, { limit: 1 })) > 0 &&
            (await collection.countDocuments({ _id: { $gte: staleBeforeId } }, { limit: 1 })) === 0;

        if (isStale) {
            await collection.drop().catch((): void => undefined);
        }
    }
};

export default async (): Promise<void> => {
    process.env.TEST_RUN_ID ||= randomHex(4);

    const superuserEmail: string = TestData.superuser.email;

    if (!superuserEmail.endsWith(testEmailDomainSuffix)) {
        throw new Error(
            `SUPERUSER_EMAIL must be a test address ending in ${testEmailDomainSuffix}, see docs/dotenv-setup.md`
        );
    }

    await mongoose.connect(process.env.DB_CONNECTION_STRING);

    const staleBefore: Date = new Date(Date.now() - staleTestDataAgeMs);
    const staleBeforeId: mongoose.Types.ObjectId = mongoose.Types.ObjectId.createFromTime(
        Math.floor(staleBefore.getTime() / 1000)
    );

    await deleteTestUsers(
        allOf(
            MongoFieldFilter.of(
                "email",
                "$regex",
                MongoParamRef.of(emailsEndingWith(testEmailDomainSuffix))
            ),
            MongoOrExpr.of([
                MongoFieldFilter.lt("createdAt", staleBefore),
                allOf(
                    MongoExistsExpr.notExists("createdAt"),
                    MongoFieldFilter.lt(
                        "_id",
                        MongoParamRef.of(new ObjectId(staleBeforeId.toHexString()))
                    )
                )
            ])
        )
    );
    await dropStaleRunCollections(staleBeforeId);
    await deleteTestUsers(MongoFieldFilter.eq("email", superuserEmail));

    const superuser: TestUser = await registerTestUser(`s${randomHex(5)}`, superuserEmail);

    await mongoose.disconnect();

    process.env.TEST_SUPERUSER_ID = superuser.id;
    process.env.TEST_SUPERUSER_USERNAME = superuser.username;
    process.env.TEST_SUPERUSER_COOKIE = superuser.cookie;
};
