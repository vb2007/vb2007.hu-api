import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { createUserUpload } from "../database/userUploads";
import { removePartialUploads } from "../helpers/partialUploads";
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

const recordUpload = (user: TestUser, id: string, filePath: string) =>
    createUserUpload({
        _id: new mongoose.Types.ObjectId(id),
        originalFileName: path.basename(filePath),
        uploadedBy: user.id,
        storedFileName: path.basename(filePath),
        filePath,
        extension: path.extname(filePath),
        fileSize: 7,
        mimeType: "image/png",
        visibility: "private"
    });

describe("Partial Upload Removal Tests", (): void => {
    let user: TestUser;
    let uploadDir: string;
    let userUploadDir: string;

    beforeAll(async (): Promise<void> => {
        user = await createTestUser("part");
        uploadDir = path.join(process.env.UPLOAD_DISK_DIRECTORY, user.id, "sweep");
        userUploadDir = path.join(uploadDir, user.id);
    });

    it("removes old upload files without a record", async (): Promise<void> => {
        const withExtension: string = await writeFile(path.join(userUploadDir, `${newId()}.png`));
        const withOddExtension: string = await writeFile(
            path.join(userUploadDir, `${newId()}.tar gz`)
        );
        const withoutExtension: string = await writeFile(path.join(userUploadDir, newId()));

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(withExtension)).toBe(false);
        expect(fs.existsSync(withOddExtension)).toBe(false);
        expect(fs.existsSync(withoutExtension)).toBe(false);
    });

    it("keeps upload files that have a record", async (): Promise<void> => {
        const id: string = newId();
        const recordedById: string = await writeFile(path.join(userUploadDir, `${id}.png`));
        const recordedByPath: string = await writeFile(path.join(userUploadDir, `${newId()}.png`));
        await recordUpload(user, id, path.join("/elsewhere", `${id}.png`));
        await recordUpload(user, newId(), recordedByPath);

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(recordedById)).toBe(true);
        expect(fs.existsSync(recordedByPath)).toBe(true);
    });

    it("keeps recent files and files outside the upload layout", async (): Promise<void> => {
        const recent: string = await writeFile(
            path.join(userUploadDir, `${newId()}.png`),
            new Date()
        );
        const otherName: string = await writeFile(path.join(userUploadDir, "notes.txt"));
        const legacyFolder: string = await writeFile(
            path.join(uploadDir, user.username, `${newId()}.png`)
        );
        const topLevel: string = await writeFile(path.join(uploadDir, `${newId()}.png`));

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(recent)).toBe(true);
        expect(fs.existsSync(otherName)).toBe(true);
        expect(fs.existsSync(legacyFolder)).toBe(true);
        expect(fs.existsSync(topLevel)).toBe(true);
    });

    it("does nothing when the upload folder doesn't exist", async (): Promise<void> => {
        await expect(
            removePartialUploads(path.join(uploadDir, "missing"), minAgeMs)
        ).resolves.toBeUndefined();
    });
});
