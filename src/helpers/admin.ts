import mongoose from "mongoose";

import { AdminShortUrlListOptions, ShortUrlWithOwner } from "../database/shortUrls";
import { SortOrder, sortOrders } from "../database/userUploads";
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

export interface AdminShortUrl {
    shortenedUrl: string;
    originalUrl: string;
    addedOn: Date;
    owner: { id: string; username: string } | null;
}

export const toAdminShortUrl = ({
    shortenedUrl,
    originalUrl,
    addedOn,
    addedBy
}: ShortUrlWithOwner): AdminShortUrl => ({
    shortenedUrl,
    originalUrl,
    addedOn,
    owner: addedBy ? { id: addedBy._id.toString(), username: addedBy.username } : null
});

const adminShortUrlListValidators: Record<
    keyof AdminShortUrlListOptions,
    (value: unknown) => boolean
> = {
    limit: userListValidators.limit,
    page: userListValidators.page,
    sortOrder: userListValidators.sortOrder,
    q: userListValidators.q
};

export const findInvalidAdminShortUrlListParam = (
    query: Record<string, unknown>
): string | undefined =>
    Object.keys(adminShortUrlListValidators).find(
        (param: keyof AdminShortUrlListOptions) =>
            query[param] !== undefined && !adminShortUrlListValidators[param](query[param])
    );

export const toAdminShortUrlListOptions = (
    query: Record<string, unknown>
): AdminShortUrlListOptions => ({
    limit: Number(query.limit ?? 20),
    page: Number(query.page ?? 1),
    sortOrder: (query.sortOrder ?? "desc") as SortOrder,
    q: query.q as string | undefined
});
