import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import { UserUploadsModel } from "../database/userUploads";

type LegacyUpload = {
    _id: mongoose.Types.ObjectId;
    originalFileName: string;
    storedFileName: string;
    filePath: string;
    extension?: string;
    uploadedBy: mongoose.Types.ObjectId;
    uploadedOn: Date;
    updatedOn?: Date;
};

type MigrationResult = "migrated" | "unchanged" | "missing";

const findLegacyFile = (upload: LegacyUpload): string | undefined => {
    const candidates: string[] = [upload.filePath];
    const legacyUploadDir: string | undefined = process.env.LEGACY_UPLOAD_DIRECTORY
        ? path.resolve(process.env.LEGACY_UPLOAD_DIRECTORY)
        : undefined;

    if (legacyUploadDir) {
        const legacyUserDir: string = path.basename(path.dirname(upload.filePath));
        candidates.push(path.join(legacyUploadDir, legacyUserDir, upload.storedFileName));
    }

    return candidates.find((candidate) => fs.existsSync(candidate));
};

const moveFile = async (from: string, to: string): Promise<void> => {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });

    try {
        await fs.promises.rename(from, to);
    } catch (error) {
        if (error.code !== "EXDEV") {
            throw error;
        }

        const tempPath: string = `${to}.migrating`;
        await fs.promises.copyFile(from, tempPath);
        await fs.promises.rename(tempPath, to);
        await fs.promises.unlink(from);
    }
};

export const migrateUpload = async (upload: LegacyUpload): Promise<MigrationResult> => {
    const uploadDir: string = path.resolve(process.env.UPLOAD_DISK_DIRECTORY);
    const extension: string =
        upload.extension ?? path.extname(upload.originalFileName).toLowerCase();
    const storedFileName: string = `${upload._id}${extension}`;
    const filePath: string = path.join(uploadDir, upload.uploadedBy.toString(), storedFileName);
    const updatedOn: Date = upload.updatedOn ?? upload.uploadedOn;

    const isRecordMigrated: boolean =
        upload.extension !== undefined &&
        upload.updatedOn !== undefined &&
        upload.storedFileName === storedFileName &&
        upload.filePath === filePath;

    if (!fs.existsSync(filePath)) {
        const legacyFile: string | undefined = findLegacyFile(upload);

        if (!legacyFile) {
            console.warn(`Skipping ${upload._id}: file not found (${upload.filePath})`);
            return "missing";
        }

        await moveFile(legacyFile, filePath);
        console.log(`Moved ${legacyFile} -> ${filePath}`);
    } else if (isRecordMigrated) {
        return "unchanged";
    }

    await UserUploadsModel.updateOne(
        { _id: upload._id },
        { $set: { extension, storedFileName, filePath, updatedOn } }
    );

    return "migrated";
};

export const migrateUploads = async (): Promise<void> => {
    const uploads = (await UserUploadsModel.find().lean()) as LegacyUpload[];
    const results: Record<MigrationResult, number> = { migrated: 0, unchanged: 0, missing: 0 };

    for (const upload of uploads) {
        results[await migrateUpload(upload)]++;
    }

    console.log(
        `Uploads: ${uploads.length}, migrated: ${results.migrated}, already migrated: ${results.unchanged}, missing file: ${results.missing}`
    );

    const { modifiedCount } = await UserUploadsModel.updateMany(
        { visibility: { $exists: false } },
        { $set: { visibility: "private" } }
    );

    console.log(`Uploads set to private: ${modifiedCount}`);
};
