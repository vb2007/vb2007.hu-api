import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { removePartialUploads, schedulePartialUploadRemoval } from "../helpers/partialUploads";
import { TestUser, createTestUser } from "./helpers/testUsers";

const minAgeMs: number = 60 * 60 * 1000;
const twoHoursAgo: Date = new Date(Date.now() - 2 * minAgeMs);

const newId = (): string => new mongoose.Types.ObjectId().toString();

const writeFile = async (filePath: string, modifiedOn: Date = twoHoursAgo): Promise<string> => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, "partial");
    await fs.promises.utimes(filePath, modifiedOn, modifiedOn);
    return filePath;
};

describe("Partial Upload Removal Tests", (): void => {
    let user: TestUser;
    let uploadDir: string;
    let userUploadDir: string;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("part");
        uploadDir = path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id, "sweep");
        userUploadDir = path.join(uploadDir, user.id);
    });

    it("removes old partial upload files", async (): Promise<void> => {
        const partial: string = await writeFile(path.join(userUploadDir, `${newId()}.partial`));

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(partial)).toBe(false);
    });

    it("keeps old completed upload files, even without a record", async (): Promise<void> => {
        const completed: string = await writeFile(path.join(userUploadDir, `${newId()}.png`));
        const withoutExtension: string = await writeFile(path.join(userUploadDir, newId()));

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(completed)).toBe(true);
        expect(fs.existsSync(withoutExtension)).toBe(true);
    });

    it("keeps recent partial uploads and files outside the upload layout", async (): Promise<void> => {
        const recent: string = await writeFile(
            path.join(userUploadDir, `${newId()}.partial`),
            new Date()
        );
        const otherName: string = await writeFile(path.join(userUploadDir, "notes.partial"));
        const otherSuffix: string = await writeFile(
            path.join(userUploadDir, `${newId()}.partial.png`)
        );
        const otherFolder: string = await writeFile(
            path.join(uploadDir, user.username, `${newId()}.partial`)
        );
        const topLevel: string = await writeFile(path.join(uploadDir, `${newId()}.partial`));

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(recent)).toBe(true);
        expect(fs.existsSync(otherName)).toBe(true);
        expect(fs.existsSync(otherSuffix)).toBe(true);
        expect(fs.existsSync(otherFolder)).toBe(true);
        expect(fs.existsSync(topLevel)).toBe(true);
    });

    it("does nothing when the upload folder doesn't exist", async (): Promise<void> => {
        await expect(
            removePartialUploads(path.join(uploadDir, "missing"), minAgeMs)
        ).resolves.toBeUndefined();
    });

    it("skips the sweep without an upload folder setting", async (): Promise<void> => {
        const uploadDiskDirectory: string = process.env.UPLOAD_DISK_DIRECTORY;
        const consoleError: jest.SpyInstance = jest.spyOn(console, "error");

        delete process.env.UPLOAD_DISK_DIRECTORY;
        try {
            expect(schedulePartialUploadRemoval).not.toThrow();
            await new Promise((resolve) => setImmediate(resolve));
        } finally {
            process.env.UPLOAD_DISK_DIRECTORY = uploadDiskDirectory;
        }

        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});
