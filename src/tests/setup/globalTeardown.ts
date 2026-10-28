import mongoose from "mongoose";
import { testEmailDomainSuffix } from "../../constants/testData";
import { PendingRegistrationModel } from "../../database/pendingRegistrations";
import { deleteTestUsers, emailsEndingWith } from "../helpers/testUsers";

export default async (): Promise<void> => {
    await mongoose.connect(process.env.DB_CONNECTION_STRING);

    const runEmails: RegExp = emailsEndingWith(
        `@${process.env.TEST_RUN_ID}${testEmailDomainSuffix}`
    );

    await deleteTestUsers({ email: runEmails });
    await PendingRegistrationModel.deleteMany({ email: runEmails });

    if (process.env.TEST_SUPERUSER_ID) {
        await deleteTestUsers({ _id: process.env.TEST_SUPERUSER_ID });
    }

    await mongoose.disconnect();
};
