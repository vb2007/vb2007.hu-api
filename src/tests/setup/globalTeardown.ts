import mongoose from "mongoose";
import { testEmailDomainSuffix } from "../../constants/testData";
import { deleteTestUsers, emailsEndingWith } from "../helpers/testUsers";

export default async (): Promise<void> => {
    await mongoose.connect(process.env.DB_CONNECTION_STRING);

    await deleteTestUsers({
        email: emailsEndingWith(`@${process.env.TEST_RUN_ID}${testEmailDomainSuffix}`)
    });

    if (process.env.TEST_SUPERUSER_ID) {
        await deleteTestUsers({ _id: process.env.TEST_SUPERUSER_ID });
    }

    await mongoose.disconnect();
};
