import express from "express";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { get } from "lodash";

import { findUploadsByIdsOrPaths } from "../database/userUploads";
import { userUploadDir } from "./userUploads";
import { PARTIAL_UPLOAD_MIN_AGE_MS, PARTIAL_UPLOAD_SWEEP_INTERVAL_MS } from "../constants/limits";

const userIdPattern: RegExp = /^[0-9a-f]{24}$/;
const uploadFileNamePattern: RegExp = /^([0-9a-f]{24})(\..*)?$/;

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
    const uploadDir: string = userUploadDir(get(req, "identity._id"));
    const uploadId: string = req.uploadId.toString();

    try {
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

const modifiedBefore = (filePath: string, cutoffMs: number): Promise<boolean> =>
    fs.promises.stat(filePath).then(
        (stats: fs.Stats): boolean => stats.mtimeMs < cutoffMs,
        (): boolean => false
    );

const removePartialUploadsIn = async (uploadDir: string, cutoffMs: number): Promise<void> => {
    const entries: fs.Dirent[] = await fs.promises
        .readdir(uploadDir, { withFileTypes: true })
        .catch((): fs.Dirent[] => []);
    const filePaths: string[] = entries
        .filter((entry: fs.Dirent): boolean => entry.isFile() && Boolean(uploadIdOf(entry.name)))
        .map((entry: fs.Dirent): string => path.join(uploadDir, entry.name));
    const isOld: boolean[] = await Promise.all(
        filePaths.map((filePath: string): Promise<boolean> => modifiedBefore(filePath, cutoffMs))
    );
    const oldFilePaths: string[] = filePaths.filter((filePath, index): boolean => isOld[index]);

    if (oldFilePaths.length === 0) {
        return;
    }

    const records = await findUploadsByIdsOrPaths(
        oldFilePaths.map((filePath: string): string => uploadIdOf(path.basename(filePath))),
        oldFilePaths
    );
    const recorded: Set<string> = new Set(
        records.flatMap((record): string[] => [record._id.toString(), record.filePath])
    );

    for (const filePath of oldFilePaths) {
        if (!recorded.has(uploadIdOf(path.basename(filePath))) && !recorded.has(filePath)) {
            await fs.promises.rm(filePath, { force: true });
            console.log(`Removed partial upload ${filePath}`);
        }
    }
};

export const removePartialUploads = async (baseDir: string, minAgeMs: number): Promise<void> => {
    const cutoffMs: number = Date.now() - minAgeMs;
    const entries: fs.Dirent[] = await fs.promises
        .readdir(baseDir, { withFileTypes: true })
        .catch((): fs.Dirent[] => []);

    for (const entry of entries) {
        if (entry.isDirectory() && userIdPattern.test(entry.name)) {
            await removePartialUploadsIn(path.join(baseDir, entry.name), cutoffMs);
        }
    }
};

export const schedulePartialUploadRemoval = (): void => {
    const sweep = (): void => {
        removePartialUploads(
            path.resolve(process.env.UPLOAD_DISK_DIRECTORY),
            PARTIAL_UPLOAD_MIN_AGE_MS
        ).catch((error: unknown): void => console.error("Removing partial uploads failed:", error));
    };

    mongoose.connection.once("open", sweep);
    setInterval(sweep, PARTIAL_UPLOAD_SWEEP_INTERVAL_MS).unref();
};
