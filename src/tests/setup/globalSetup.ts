import mongoose from "mongoose";
import dotenv from "dotenv";
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

    await deleteTestUsers({
        email: emailsEndingWith(testEmailDomainSuffix),
        $or: [
            { createdAt: { $lt: staleBefore } },
            { createdAt: { $exists: false }, _id: { $lt: staleBeforeId } }
        ]
    });
    await deleteTestUsers({ email: superuserEmail });

    await mongoose.disconnect();

    const superuser: TestUser = await registerTestUser(`s${randomHex(5)}`, superuserEmail);

    process.env.TEST_SUPERUSER_ID = superuser.id;
    process.env.TEST_SUPERUSER_USERNAME = superuser.username;
    process.env.TEST_SUPERUSER_COOKIE = superuser.cookie;
};
