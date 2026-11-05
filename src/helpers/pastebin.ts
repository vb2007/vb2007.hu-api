import { LIST_MAX_LIMIT } from "../constants/limits";
import { PasteListOptions, PasteSortField, pasteSortFields } from "../database/pastebin";
import { SortOrder, sortOrders } from "../database/userUploads";
import { isIntegerInRange } from "./userUploads";

const pasteListValidators: Record<keyof PasteListOptions, (value: unknown) => boolean> = {
    limit: (value) => isIntegerInRange(value, 1, LIST_MAX_LIMIT),
    page: (value) => isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER),
    sortBy: (value) => pasteSortFields.includes(value as PasteSortField),
    sortOrder: (value) => sortOrders.includes(value as SortOrder)
};

export const findInvalidPasteListParam = (query: Record<string, unknown>): string | undefined =>
    Object.keys(pasteListValidators).find(
        (param: keyof PasteListOptions) =>
            query[param] !== undefined && !pasteListValidators[param](query[param])
    );

export const toPasteListOptions = (query: Record<string, unknown>): PasteListOptions => ({
    limit: Number(query.limit ?? 10),
    page: Number(query.page ?? 1),
    sortBy: (query.sortBy ?? "addedOn") as PasteSortField,
    sortOrder: (query.sortOrder ?? "desc") as SortOrder
});

export const toPastePagination = (options: PasteListOptions, total: number) => ({
    limit: options.limit,
    page: options.page,
    total,
    pages: Math.ceil(total / options.limit),
    sortBy: options.sortBy,
    sortOrder: options.sortOrder
});
