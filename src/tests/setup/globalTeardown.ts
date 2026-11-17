import { db } from "../../prisma/db";
import { testEmailDomainSuffix } from "../../constants/testData";
import { MongoFieldFilter } from "@prisma/orm-mongo/query-ast";
import { MongoParamRef } from "@prisma/orm-mongo/value";
import { idIs, runQuery } from "../../helpers/prisma";
import { deleteTestUsers, emailsOnOrUnder } from "../helpers/testUsers";

export default async (): Promise<void> => {
    const runEmails: RegExp = emailsOnOrUnder(`${process.env.TEST_RUN_ID}${testEmailDomainSuffix}`);

    const isRunEmail = MongoFieldFilter.of("email", "$regex", MongoParamRef.of(runEmails));

    await deleteTestUsers(isRunEmail);
    await runQuery(db.query.from("pendingregistrations").match(isRunEmail).deleteMany());

    if (process.env.TEST_SUPERUSER_ID) {
        await deleteTestUsers(idIs(process.env.TEST_SUPERUSER_ID));
    }

    await db.close();
};
