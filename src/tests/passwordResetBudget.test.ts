process.env.SMTP_HOST = "smtp.example.test";
process.env.MAIL_FROM = "vb2007.hu <noreply@vb2007.hu>";
delete process.env.MAIL_DAILY_LIMIT;

const mockSendMail: jest.Mock = jest.fn();

jest.mock("nodemailer", () => ({
    __esModule: true,
    default: { createTransport: () => ({ sendMail: mockSendMail }) }
}));

const { readMailBudget }: typeof import("../helpers/mail") = require("../helpers/mail");
const {
    runRequestReset
}: typeof import("./helpers/passwordReset") = require("./helpers/passwordReset");
const { UserModel }: typeof import("../database/users") = require("../database/users");
const {
    createTestUser,
    randomHex
}: typeof import("./helpers/testUsers") = require("./helpers/testUsers");

describe("Password Reset Mail Budget Tests", (): void => {
    const deliverable = (): string => `${randomHex(8)}@deliverable.vb2007.hu`;

    beforeEach((): void => {
        mockSendMail.mockReset().mockResolvedValue({});
    });

    it("should count a reset to an existing account exactly once, like one to an unknown address", async (): Promise<void> => {
        const user = await createTestUser("pb");
        const address: string = deliverable();
        await UserModel.updateOne({ _id: user.id }, { $set: { email: address } });

        try {
            const start: number = readMailBudget().sentToday;

            const existing = await runRequestReset(address);
            expect(readMailBudget().sentToday).toBe(start + 1);
            expect(mockSendMail).toHaveBeenCalledTimes(1);

            const unknown = await runRequestReset(deliverable());
            expect(readMailBudget().sentToday).toBe(start + 2);
            expect(mockSendMail).toHaveBeenCalledTimes(1);

            const cooling = await runRequestReset(address);
            expect(readMailBudget().sentToday).toBe(start + 3);
            expect(mockSendMail).toHaveBeenCalledTimes(1);

            expect(unknown).toEqual(existing);
            expect(cooling).toEqual(existing);
        } finally {
            await UserModel.updateOne({ _id: user.id }, { $set: { email: user.email } });
        }
    });
});
