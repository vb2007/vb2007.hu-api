import express from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { get } from "lodash";

import { userUploadDir } from "./userUploads";
import { PARTIAL_UPLOAD_MIN_AGE_MS, PARTIAL_UPLOAD_SWEEP_INTERVAL_MS } from "../constants/limits";

const userIdPattern: RegExp = /^[0-9a-f]{24}$/;
const partialUploadPattern: RegExp = /^[0-9a-f]{24}~partial$/;

export const partialUploadFileName = (uploadId: mongoose.Types.ObjectId | string): string =>
    `${uploadId}~partial`;

const uploadsInFlight: Set<express.Request> = new Set();

export const trackUploadInFlight = (req: express.Request): void => {
    uploadsInFlight.add(req);
};

export const untrackUploadInFlight = (req: express.Request): void => {
    uploadsInFlight.delete(req);
};

export const untrackUploadInFlightOnClose = (req: express.Request): void => {
    if (!uploadsInFlight.has(req)) {
        return;
    }

    if (req.res.closed) {
        untrackUploadInFlight(req);
        return;
    }

    req.res.once("close", (): void => untrackUploadInFlight(req));
};

const isFileOfUpload = (fileName: string, uploadId: string): boolean =>
    fileName === partialUploadFileName(uploadId) || fileName.startsWith(`${uploadId}.`);

const removeUploadInFlight = (req: express.Request): void => {
    try {
        const uploadDir: string = userUploadDir(get(req, "identity._id"));
        const uploadId: string = req.uploadId.toString();

        fs.readdirSync(uploadDir)
            .filter((fileName: string): boolean => isFileOfUpload(fileName, uploadId))
            .forEach((fileName: string): void => {
                fs.rmSync(path.join(uploadDir, fileName), { force: true });
                console.log(`Removed in-flight upload ${path.join(uploadDir, fileName)}`);
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

const ignoreMissing =
    <T>(fallback: T) =>
    (error: NodeJS.ErrnoException): T => {
        if (error.code === "ENOENT") {
            return fallback;
        }
        throw error;
    };

const removeIfOlderThan = async (filePath: string, cutoffMs: number): Promise<void> => {
    const stats: fs.Stats | undefined = await fs.promises
        .stat(filePath)
        .catch(ignoreMissing(undefined));

    if (stats?.isFile() && stats.mtimeMs < cutoffMs) {
        await fs.promises.rm(filePath, { force: true });
        console.log(`Removed partial upload ${filePath}`);
    }
};

const removePartialUploadsIn = async (uploadDir: string, cutoffMs: number): Promise<void> => {
    const fileNames: string[] = await fs.promises.readdir(uploadDir).catch(ignoreMissing([]));

    for (const fileName of fileNames) {
        if (partialUploadPattern.test(fileName)) {
            await removeIfOlderThan(path.join(uploadDir, fileName), cutoffMs).catch(
                (error: unknown): void => console.error("Removing a partial upload failed:", error)
            );
        }
    }
};

export const removePartialUploads = async (baseDir: string, minAgeMs: number): Promise<void> => {
    const cutoffMs: number = Date.now() - minAgeMs;
    const entries: fs.Dirent[] = await fs.promises
        .readdir(baseDir, { withFileTypes: true })
        .catch(ignoreMissing([]));

    for (const entry of entries) {
        if (entry.isDirectory() && userIdPattern.test(entry.name)) {
            await removePartialUploadsIn(path.join(baseDir, entry.name), cutoffMs).catch(
                (error: unknown): void => console.error("Reading an upload folder failed:", error)
            );
        }
    }
};

export const removePartialUploadsFromUploadDir = async (): Promise<void> => {
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
