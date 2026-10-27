import mongoose from "mongoose";
import dotenv from "dotenv";

import { UPLOAD_CATEGORIES, UploadCategory } from "../constants/uploads";
import { getUserUploadQuota } from "../database/users";
import { getUploadUsageByUser } from "../database/userUploads";

dotenv.config();

const defaultUploadQuotaMb: number = 10240;

const parseUploadQuotaMb = (value: string | undefined): number => {
    const quotaMb: number = Number(value);
    return Number.isInteger(quotaMb) && quotaMb > 0 ? quotaMb : defaultUploadQuotaMb;
};

export const defaultUploadQuotaBytes: number =
    parseUploadQuotaMb(process.env.UPLOAD_USER_QUOTA_MB) * 1024 * 1024;

export interface UploadUsage {
    usedBytes: number;
    count: number;
    byCategory: { category: UploadCategory; bytes: number; count: number }[];
}

export const getUploadQuotaBytes = async (
    userId: mongoose.Types.ObjectId | string
): Promise<number> => {
    const user = await getUserUploadQuota(userId);
    return user?.uploadQuotaBytes ?? defaultUploadQuotaBytes;
};

export const calculateUploadUsage = async (
    userId: mongoose.Types.ObjectId | string
): Promise<UploadUsage> => {
    const groups = await getUploadUsageByUser(userId);

    const byCategory = UPLOAD_CATEGORIES.map((category) => {
        const group = groups.find(({ _id }) => _id === category);
        return { category, bytes: group?.bytes ?? 0, count: group?.count ?? 0 };
    });

    return {
        usedBytes: byCategory.reduce((total, { bytes }) => total + bytes, 0),
        count: byCategory.reduce((total, { count }) => total + count, 0),
        byCategory
    };
};

export const exceedsUploadQuota = async (
    userId: mongoose.Types.ObjectId | string,
    addedBytes: number = 0
): Promise<boolean> => {
    const [quotaBytes, { usedBytes }] = await Promise.all([
        getUploadQuotaBytes(userId),
        calculateUploadUsage(userId)
    ]);

    return usedBytes + addedBytes > quotaBytes;
};

const uploadLocks: Map<string, Promise<unknown>> = new Map();

export const withUploadLock = async <T>(
    userId: mongoose.Types.ObjectId | string,
    task: () => Promise<T>
): Promise<T> => {
    const key: string = userId.toString();
    const current: Promise<T> = (uploadLocks.get(key) ?? Promise.resolve())
        .catch((): void => undefined)
        .then(task);

    uploadLocks.set(key, current);

    try {
        return await current;
    } finally {
        if (uploadLocks.get(key) === current) {
            uploadLocks.delete(key);
        }
    }
};
