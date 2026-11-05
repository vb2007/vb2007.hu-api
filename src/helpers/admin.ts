import mongoose from "mongoose";
import net from "net";

import { AdminPasteListOptions, PasteWithOwner } from "../database/pastebin";
import { ShortUrlWithOwner } from "../database/shortUrls";
import { SortOrder, UploadVisibility, sortOrders } from "../database/userUploads";
import { UserListOptions, UserSortField, userSortFields } from "../database/users";
import { isNonEmptyString, isSuperuserEmail, normalizeEmail } from ".";
import { isIntegerInRange } from "./userUploads";
import { pasteListValidators, toPasteListOptions } from "./pastebin";
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

export const isRateLimitEmail = (value: unknown): value is string =>
    isNonEmptyString(value) && isNonEmptyString(normalizeEmail(value));

export const isRateLimitIp = (value: unknown): value is string =>
    typeof value === "string" && net.isIP(value) !== 0;

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

export interface AdminPaste {
    id: string;
    language: string | null;
    preview: string;
    addedOn: Date;
    owner: UploadOwner | null;
}

export const toAdminPaste = (paste: PasteWithOwner): AdminPaste => ({
    id: paste._id.toString(),
    language: paste.language ?? null,
    preview: paste.preview,
    addedOn: paste.addedOn,
    owner: paste.owner ? { id: paste.owner._id.toString(), username: paste.owner.username } : null
});

const adminPasteListValidators: Record<keyof AdminPasteListOptions, (value: unknown) => boolean> = {
    ...pasteListValidators,
    q: userListValidators.q
};

export const findInvalidAdminPasteListParam = (
    query: Record<string, unknown>
): string | undefined =>
    Object.keys(adminPasteListValidators).find(
        (param: keyof AdminPasteListOptions) =>
            query[param] !== undefined && !adminPasteListValidators[param](query[param])
    );

export const toAdminPasteListOptions = (query: Record<string, unknown>): AdminPasteListOptions => ({
    ...toPasteListOptions(query, 20),
    q: query.q as string | undefined
});
