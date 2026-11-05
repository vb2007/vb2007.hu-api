import mongoose from "mongoose";

import { SortOrder, UploadVisibility, sortOrders } from "../database/userUploads";
import { UserListOptions, UserSortField, userSortFields } from "../database/users";
import { isSuperuserEmail } from ".";
import { isIntegerInRange } from "./userUploads";
import { UploadUsage, defaultUploadQuotaBytes } from "./uploadQuota";

export interface AdminUser {
    id: string;
    username: string;
    email: string;
    createdAt: string;
    isSuperuser: boolean;
    suspendedAt: string | null;
    uploads: {
        usedBytes: number;
        count: number;
        quotaBytes: number;
        hasCustomQuota: boolean;
    };
}

interface AdminUserRecord {
    _id: mongoose.Types.ObjectId;
    username: string;
    email: string;
    createdAt?: Date;
    uploadQuotaBytes?: number | null;
    suspendedAt?: Date | null;
}

export const toAdminUser = (
    user: AdminUserRecord,
    usage: Pick<UploadUsage, "usedBytes" | "count">
): AdminUser => ({
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    createdAt: (user.createdAt ?? user._id.getTimestamp()).toISOString(),
    isSuperuser: isSuperuserEmail(user.email),
    suspendedAt: user.suspendedAt?.toISOString() ?? null,
    uploads: {
        usedBytes: usage.usedBytes,
        count: usage.count,
        quotaBytes: user.uploadQuotaBytes ?? defaultUploadQuotaBytes,
        hasCustomQuota: user.uploadQuotaBytes != null
    }
});

export const isUploadQuota = (value: unknown): value is number | null =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

const userListValidators: Record<keyof UserListOptions, (value: unknown) => boolean> = {
    limit: (value) => isIntegerInRange(value, 1, 50),
    page: (value) => isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER),
    sortBy: (value) => userSortFields.includes(value as UserSortField),
    sortOrder: (value) => sortOrders.includes(value as SortOrder),
    q: (value) => typeof value === "string" && value.length <= 100
};

export const findInvalidUserListParam = (query: Record<string, unknown>): string | undefined =>
    Object.keys(userListValidators).find(
        (param: keyof UserListOptions) =>
            query[param] !== undefined && !userListValidators[param](query[param])
    );

export const toUserListOptions = (query: Record<string, unknown>): UserListOptions => ({
    limit: Number(query.limit ?? 20),
    page: Number(query.page ?? 1),
    sortBy: (query.sortBy ?? "usedBytes") as UserSortField,
    sortOrder: (query.sortOrder ?? "desc") as SortOrder,
    q: query.q as string | undefined
});

export interface UploadOwner {
    id: string;
    username: string;
}

export const toUploadOwners = (
    users: { _id: mongoose.Types.ObjectId; username: string }[]
): Map<string, UploadOwner> =>
    new Map(
        users.map((user) => [
            user._id.toString(),
            { id: user._id.toString(), username: user.username }
        ])
    );

export interface UploadTotals {
    total: number;
    public: number;
    private: number;
    storedBytes: number;
}

export const toUploadTotals = (
    groups: { _id: UploadVisibility; bytes: number; count: number }[]
): UploadTotals => {
    const countOf = (visibility: UploadVisibility): number =>
        groups.find(({ _id }) => _id === visibility)?.count ?? 0;

    return {
        total: groups.reduce((total, { count }) => total + count, 0),
        public: countOf("public"),
        private: countOf("private"),
        storedBytes: groups.reduce((total, { bytes }) => total + bytes, 0)
    };
};
