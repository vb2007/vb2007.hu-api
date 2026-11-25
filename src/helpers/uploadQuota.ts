import dotenv from "dotenv";

import { UPLOAD_CATEGORIES, UploadCategory } from "../constants/uploads";
import { getUserUploadQuota } from "../database/users";
import { getUploadUsageByUser } from "../database/userUploads";
import { parsePositiveInteger } from "./index";
import { MAX_SAFE_MEGABYTES, UPLOADS_PER_ACCOUNT } from "../constants/limits";
import { Responses } from "../constants/responses";
import type { UploadRejection } from "./multer";

dotenv.config();

const defaultUploadQuotaMb: number = 10240;

export const defaultUploadQuotaBytes: number =
    parsePositiveInteger(
        process.env.UPLOAD_USER_QUOTA_MB,
        defaultUploadQuotaMb,
        MAX_SAFE_MEGABYTES
    ) *
    1024 *
    1024;

export interface UploadUsage {
    usedBytes: number;
    count: number;
    byCategory: { category: UploadCategory; bytes: number; count: number }[];
}

export const getUploadQuotaBytes = async (userId: string): Promise<number> => {
    const user = await getUserUploadQuota(userId);
    return user?.uploadQuotaBytes ?? defaultUploadQuotaBytes;
};

export const calculateUploadUsage = async (userId: string): Promise<UploadUsage> => {
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

export const findUploadLimitRejection = async (
    userId: string,
    addedBytes: number = 0,
    addedUploads: number = 0
): Promise<UploadRejection | null> => {
    const [quotaBytes, { usedBytes, count }] = await Promise.all([
        getUploadQuotaBytes(userId),
        calculateUploadUsage(userId)
    ]);

    if (count + addedUploads > UPLOADS_PER_ACCOUNT) {
        return { status: 409, error: Responses.UserUploads.tooManyUploads };
    }

    if (usedBytes + addedBytes > quotaBytes) {
        return { status: 413, error: Responses.UserUploads.quotaExceeded };
    }

    return null;
};
