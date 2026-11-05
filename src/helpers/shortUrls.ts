import { ShortUrlListOptions, ShortUrlSortField, shortUrlSortFields } from "../database/shortUrls";
import { SortOrder, sortOrders } from "../database/userUploads";
import { isIntegerInRange } from "./userUploads";

const shortUrlListValidators: Record<keyof ShortUrlListOptions, (value: unknown) => boolean> = {
    limit: (value) => isIntegerInRange(value, 1, 50),
    page: (value) => isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER),
    sortBy: (value) => shortUrlSortFields.includes(value as ShortUrlSortField),
    sortOrder: (value) => sortOrders.includes(value as SortOrder),
    q: (value) => typeof value === "string" && value.length <= 100
};

export const findInvalidShortUrlListParam = (query: Record<string, unknown>): string | undefined =>
    Object.keys(shortUrlListValidators).find(
        (param: keyof ShortUrlListOptions) =>
            query[param] !== undefined && !shortUrlListValidators[param](query[param])
    );

export const toShortUrlListOptions = (query: Record<string, unknown>): ShortUrlListOptions => ({
    limit: Number(query.limit ?? 10),
    page: Number(query.page ?? 1),
    sortBy: (query.sortBy ?? "addedOn") as ShortUrlSortField,
    sortOrder: (query.sortOrder ?? "desc") as SortOrder,
    q: query.q as string | undefined
});

export const toShortUrlPagination = (options: ShortUrlListOptions, total: number) => ({
    limit: options.limit,
    page: options.page,
    total,
    pages: Math.ceil(total / options.limit),
    sortBy: options.sortBy,
    sortOrder: options.sortOrder
});
