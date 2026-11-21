import dotenv from "dotenv";
import { ObjectId } from "@prisma/orm-mongo/bson";
import { MongoExistsExpr, MongoFieldFilter, MongoOrExpr } from "@prisma/orm-mongo/query-ast";
import { DropCollectionCommand } from "@prisma/orm-mongo/query-ast/control";
import { MongoParamRef } from "@prisma/orm-mongo/value";
import { db } from "../../prisma/db";
import { withControl } from "../../prisma/control";
import { allOf } from "../../helpers/prisma";
import { TestData, runCollectionPattern, testEmailDomainSuffix } from "../../constants/testData";
import {
    TestUser,
    deleteTestUsers,
    emailsEndingWith,
    randomHex,
    registerTestUser
} from "../helpers/testUsers";

dotenv.config();

const staleTestDataAgeMs: number = 1000 * 60 * 60 * 24;

const dropStaleRunCollections = (staleBefore: Date): Promise<void> =>
    withControl(async ({ run, listCollectionNames }): Promise<void> => {
        for (const name of await listCollectionNames()) {
            const [, createdHex, runId] = name.match(runCollectionPattern) ?? [];
            const isStale: boolean =
                Boolean(runId) &&
                runId !== process.env.TEST_RUN_ID &&
                parseInt(createdHex, 16) * 1000 < staleBefore.getTime();

            if (isStale) {
                await run(new DropCollectionCommand(name));
            }
        }
    });

const deleteStaleRunMigrations = (staleBefore: Date): Promise<number> =>
    db.orm.migrations
        .where(
            allOf(
                MongoFieldFilter.of("name", "$regex", MongoParamRef.of(/^test-/)),
                MongoFieldFilter.lt("appliedOn", staleBefore)
            )
        )
        .deleteAndCount();

export default async (): Promise<void> => {
    process.env.TEST_RUN_ID ||= randomHex(4);

    const superuserEmail: string = TestData.superuser.email;

    if (!superuserEmail.endsWith(testEmailDomainSuffix)) {
        throw new Error(
            `SUPERUSER_EMAIL must be a test address ending in ${testEmailDomainSuffix}, see docs/dotenv-setup.md`
        );
    }

    const staleBefore: Date = new Date(Date.now() - staleTestDataAgeMs);
    const staleBeforeId: ObjectId = ObjectId.createFromTime(
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
                    MongoFieldFilter.lt("_id", MongoParamRef.of(staleBeforeId))
                )
            ])
        )
    );
    await dropStaleRunCollections(staleBefore);
    await deleteStaleRunMigrations(staleBefore);
    await deleteTestUsers(MongoFieldFilter.eq("email", superuserEmail));

    const superuser: TestUser = await registerTestUser(`s${randomHex(5)}`, superuserEmail);

    process.env.TEST_SUPERUSER_ID = superuser.id;
    process.env.TEST_SUPERUSER_USERNAME = superuser.username;
    process.env.TEST_SUPERUSER_COOKIE = superuser.cookie;
    process.env.TEST_SUPERUSER_PASSWORD = superuser.password;
};
