import express from "express";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { verifyUploadType } from "../middlewares";
import {
    partialUploadFileName,
    removePartialUploads,
    removePartialUploadsFromUploadDir
} from "../helpers/partialUploads";
import { TestUser, createTestUser } from "./helpers/testUsers";

jest.mock("../helpers/fileType", () => ({
    detectUploadType: async () => ({ extension: ".jpg", mimeType: "image/jpeg" })
}));

const minAgeMs: number = 60 * 60 * 1000;
const twoHoursAgo: Date = new Date(Date.now() - 2 * minAgeMs);
const canLockFolders: boolean = process.getuid() !== 0;

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
        const partial: string = await writeFile(
            path.join(userUploadDir, partialUploadFileName(newId()))
        );

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(partial)).toBe(false);
    });

    it("keeps old completed upload files, even without a record", async (): Promise<void> => {
        const completed: string = await writeFile(path.join(userUploadDir, `${newId()}.png`));
        const legacyPartialExtension: string = await writeFile(
            path.join(userUploadDir, `${newId()}.partial`)
        );
        const withoutExtension: string = await writeFile(path.join(userUploadDir, newId()));

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(completed)).toBe(true);
        expect(fs.existsSync(legacyPartialExtension)).toBe(true);
        expect(fs.existsSync(withoutExtension)).toBe(true);
    });

    it("keeps recent partial uploads and files outside the upload layout", async (): Promise<void> => {
        const recent: string = await writeFile(
            path.join(userUploadDir, partialUploadFileName(newId())),
            new Date()
        );
        const otherName: string = await writeFile(path.join(userUploadDir, "notes~partial"));
        const otherSuffix: string = await writeFile(
            path.join(userUploadDir, `${partialUploadFileName(newId())}.png`)
        );
        const otherFolder: string = await writeFile(
            path.join(uploadDir, user.username, partialUploadFileName(newId()))
        );
        const topLevel: string = await writeFile(
            path.join(uploadDir, partialUploadFileName(newId()))
        );

        await removePartialUploads(uploadDir, minAgeMs);

        expect(fs.existsSync(recent)).toBe(true);
        expect(fs.existsSync(otherName)).toBe(true);
        expect(fs.existsSync(otherSuffix)).toBe(true);
        expect(fs.existsSync(otherFolder)).toBe(true);
        expect(fs.existsSync(topLevel)).toBe(true);
    });

    (canLockFolders ? it : it.skip)(
        "logs an unreadable upload folder and sweeps the others",
        async (): Promise<void> => {
            const lockedDir: string = path.join(uploadDir, newId());
            const lockedPartial: string = await writeFile(
                path.join(lockedDir, partialUploadFileName(newId()))
            );
            const partial: string = await writeFile(
                path.join(userUploadDir, partialUploadFileName(newId()))
            );
            const consoleError: jest.SpyInstance = jest
                .spyOn(console, "error")
                .mockImplementation((): void => undefined);

            await fs.promises.chmod(lockedDir, 0o000);
            try {
                await removePartialUploads(uploadDir, minAgeMs);
                expect(consoleError).toHaveBeenCalledWith(
                    "Reading an upload folder failed:",
                    expect.objectContaining({ code: "EACCES" })
                );
            } finally {
                await fs.promises.chmod(lockedDir, 0o755);
                consoleError.mockRestore();
            }

            expect(fs.existsSync(lockedPartial)).toBe(true);
            expect(fs.existsSync(partial)).toBe(false);
        }
    );

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
            await expect(removePartialUploadsFromUploadDir()).resolves.toBeUndefined();
        } finally {
            process.env.UPLOAD_DISK_DIRECTORY = uploadDiskDirectory;
        }

        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it("removes the partial file when renaming it fails", async (): Promise<void> => {
        const uploadId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId();
        const renameDir: string = path.join(uploadDir, "rename");
        const partial: string = await writeFile(
            path.join(renameDir, partialUploadFileName(uploadId)),
            new Date()
        );
        await fs.promises.mkdir(path.join(renameDir, `${uploadId}.jpg`, "taken"), {
            recursive: true
        });
        const req = {
            uploadId,
            identity: { _id: user.id },
            file: {
                path: partial,
                destination: renameDir,
                filename: path.basename(partial),
                originalname: "photo.jpg"
            }
        } as unknown as express.Request;
        const next: jest.Mock = jest.fn();

        await verifyUploadType(req, {} as express.Response, next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "EISDIR" }));
        expect(fs.existsSync(partial)).toBe(false);
    });
});
