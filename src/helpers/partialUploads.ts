import express from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { get } from "lodash";

import { userUploadDir } from "./userUploads";
import { PARTIAL_UPLOAD_MIN_AGE_MS, PARTIAL_UPLOAD_SWEEP_INTERVAL_MS } from "../constants/limits";

const userIdPattern: RegExp = /^[0-9a-f]{24}$/;
const uploadFileNamePattern: RegExp = /^([0-9a-f]{24})(\..*)?$/;
const partialUploadPattern: RegExp = /^[0-9a-f]{24}\.partial$/;

export const partialUploadFileName = (uploadId: mongoose.Types.ObjectId): string =>
    `${uploadId}.partial`;

const uploadsInFlight: Set<express.Request> = new Set();

const uploadIdOf = (fileName: string): string | undefined =>
    fileName.match(uploadFileNamePattern)?.[1];

export const trackUploadInFlight = (req: express.Request): void => {
    uploadsInFlight.add(req);
    req.res.once("close", (): void => {
        uploadsInFlight.delete(req);
    });
};

export const untrackUploadInFlight = (req: express.Request): void => {
    uploadsInFlight.delete(req);
};

const removeUploadInFlight = (req: express.Request): void => {
    try {
        const uploadDir: string = userUploadDir(get(req, "identity._id"));
        const uploadId: string = req.uploadId.toString();

        fs.readdirSync(uploadDir)
            .filter((fileName: string): boolean => uploadIdOf(fileName) === uploadId)
            .forEach((fileName: string): void => {
                fs.rmSync(path.join(uploadDir, fileName), { force: true });
                console.log(`Removed partial upload ${path.join(uploadDir, fileName)}`);
            });
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error(error);
        }
    }
};

export const removeUploadsInFlight = (): void => {
    uploadsInFlight.forEach(removeUploadInFlight);
};

const isPartialUploadOlderThan = (filePath: string, cutoffMs: number): Promise<boolean> =>
    fs.promises.stat(filePath).then(
        (stats: fs.Stats): boolean => stats.isFile() && stats.mtimeMs < cutoffMs,
        (): boolean => false
    );

const removePartialUploadsIn = async (uploadDir: string, cutoffMs: number): Promise<void> => {
    const fileNames: string[] = await fs.promises.readdir(uploadDir).catch((): string[] => []);

    for (const fileName of fileNames.filter((name: string): boolean =>
        partialUploadPattern.test(name)
    )) {
        const filePath: string = path.join(uploadDir, fileName);

        if (await isPartialUploadOlderThan(filePath, cutoffMs)) {
            await fs.promises.rm(filePath, { force: true });
            console.log(`Removed partial upload ${filePath}`);
        }
    }
};

export const removePartialUploads = async (baseDir: string, minAgeMs: number): Promise<void> => {
    const cutoffMs: number = Date.now() - minAgeMs;
    const entries: fs.Dirent[] = await fs.promises
        .readdir(baseDir, { withFileTypes: true })
        .catch((error: NodeJS.ErrnoException): fs.Dirent[] => {
            if (error.code === "ENOENT") {
                return [];
            }
            throw error;
        });

    for (const entry of entries) {
        if (entry.isDirectory() && userIdPattern.test(entry.name)) {
            await removePartialUploadsIn(path.join(baseDir, entry.name), cutoffMs);
        }
    }
};

const removePartialUploadsFromUploadDir = async (): Promise<void> => {
    if (!process.env.UPLOAD_DISK_DIRECTORY) {
        return;
    }

    try {
        await removePartialUploads(
            path.resolve(process.env.UPLOAD_DISK_DIRECTORY),
            PARTIAL_UPLOAD_MIN_AGE_MS
        );
    } catch (error) {
        console.error("Removing partial uploads failed:", error);
    }
};

export const schedulePartialUploadRemoval = (): void => {
    removePartialUploadsFromUploadDir().finally((): void => {
        setTimeout(schedulePartialUploadRemoval, PARTIAL_UPLOAD_SWEEP_INTERVAL_MS).unref();
    });
};
