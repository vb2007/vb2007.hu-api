import {
    MongoAndExpr,
    MongoFieldFilter,
    MongoFilterExpr,
    MongoOrExpr
} from "@prisma/orm-mongo/query-ast";
import { StringField, TypedAggExpr, acc, fn } from "@prisma/orm-mongo/query-builder";

import { ALLOWED_UPLOAD_TYPES, UploadCategory } from "../constants/uploads";
import { db } from "../prisma/db";
import {
    containsIgnoringCase,
    countOf,
    objectIdParam,
    runQuery,
    stringOperator
} from "../helpers/prisma";

export const uploadVisibilities = ["public", "private"] as const;

export type UploadVisibility = (typeof uploadVisibilities)[number];

export const uploadSortFields = ["uploadedOn", "originalFileName", "fileSize"] as const;

export type UploadSortField = (typeof uploadSortFields)[number];

export const sortOrders = ["asc", "desc"] as const;

export type SortOrder = (typeof sortOrders)[number];

export interface UploadListOptions {
    limit: number;
    page: number;
    sortBy: UploadSortField;
    sortOrder: SortOrder;
    visibility?: UploadVisibility;
    q?: string;
}

export interface NewUpload {
    id: string;
    originalFileName: string;
    uploadedBy: unknown;
    storedFileName: string;
    filePath: string;
    extension: string;
    fileSize: number;
    mimeType: string;
    visibility?: UploadVisibility;
}

export interface UploadChanges {
    originalFileName?: string;
    visibility?: UploadVisibility;
    updatedOn: Date;
}

const assertUploadVisibility = (visibility: unknown): void => {
    if (visibility !== undefined && !uploadVisibilities.includes(visibility as UploadVisibility)) {
        throw new Error("Upload validation failed: invalid visibility");
    }
};

const assertNewUpload = (values: NewUpload): void => {
    const textFields: unknown[] = [
        values.id,
        values.originalFileName,
        values.storedFileName,
        values.filePath,
        values.extension,
        values.mimeType
    ];

    if (
        textFields.some((value: unknown): boolean => typeof value !== "string" || !value) ||
        typeof values.fileSize !== "number" ||
        !values.uploadedBy
    ) {
        throw new Error("Upload validation failed: missing required fields");
    }

    assertUploadVisibility(values.visibility);
};

export const getUploadById = (id: string) => db.orm.useruploads.where({ id }).first();

export type UserUpload = NonNullable<Awaited<ReturnType<typeof getUploadById>>>;

export const getUploadAccessById = (id: string) =>
    db.orm.useruploads
        .where({ id })
        .select("uploadedBy", "visibility", "extension", "originalFileName")
        .first();

export const createUserUpload = (values: NewUpload) => {
    assertNewUpload(values);

    const now: Date = new Date();

    return db.orm.useruploads.create({
        ...values,
        uploadedBy: String(values.uploadedBy),
        visibility: values.visibility ?? "private",
        uploadedOn: now,
        updatedOn: now
    });
};

export const updateUploadById = (id: string, values: UploadChanges) => {
    assertUploadVisibility(values.visibility);

    return db.orm.useruploads.where({ id }).update(values);
};

const fileNameFilter = (q: string): MongoFilterExpr => containsIgnoringCase("originalFileName", q);

const fileNameCollator: Intl.Collator = new Intl.Collator("en", { sensitivity: "accent" });

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const findUploadPage = async (
    filter: MongoFilterExpr | undefined,
    { limit, page, sortBy, sortOrder, visibility }: UploadListOptions
) => {
    const pageFilters: MongoFilterExpr[] = [
        filter,
        visibility && MongoFieldFilter.eq("visibility", visibility)
    ].filter(Boolean);
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const pageStart: number = (page - 1) * limit;
    const uploads = db.query.from("useruploads");
    const matchingUploads = pageFilters.length
        ? uploads.match(MongoAndExpr.of(pageFilters))
        : uploads;

    if (sortBy === "originalFileName") {
        // shortcut: sorts every matching file name in memory to keep the en collation, move to a stored sort key once a list outgrows that
        const names = await runQuery(matchingUploads.project("originalFileName").build());
        const pageIds: string[] = names
            .sort(
                (a, b) =>
                    sortDirection *
                    (fileNameCollator.compare(a.originalFileName, b.originalFileName) ||
                        compareIds(a._id, b._id))
            )
            .slice(pageStart, pageStart + limit)
            .map(({ _id }) => _id);
        const rows = await runQuery(
            uploads.match(MongoFieldFilter.in("_id", pageIds.map(objectIdParam))).build()
        );
        const rowsById = new Map(rows.map(({ _id, ...upload }) => [_id, { ...upload, id: _id }]));

        return [pageIds.map((id) => rowsById.get(id)).filter(Boolean), names.length] as const;
    }

    const [rows, total] = await Promise.all([
        runQuery(
            matchingUploads
                .sort({ [sortBy]: sortDirection, _id: sortDirection })
                .skip(pageStart)
                .limit(limit)
                .build()
        ),
        countOf(matchingUploads.count("n").build())
    ]);

    return [rows.map(({ _id, ...upload }) => ({ ...upload, id: _id })), total] as const;
};

export const findUploadsByUser = (userId: unknown, options: UploadListOptions) => {
    const ownerFilter: MongoFilterExpr = MongoFieldFilter.eq("uploadedBy", objectIdParam(userId));

    return findUploadPage(
        options.q ? MongoAndExpr.of([ownerFilter, fileNameFilter(options.q)]) : ownerFilter,
        options
    );
};

export const findUploads = (options: UploadListOptions, usernameMatchIds: unknown[]) =>
    findUploadPage(
        options.q
            ? MongoOrExpr.of([
                  fileNameFilter(options.q),
                  MongoFieldFilter.in("uploadedBy", usernameMatchIds.map(objectIdParam))
              ])
            : undefined,
        options
    );

export const getUploadUsageByUser = (userId: unknown) =>
    runQuery(
        db.query
            .from("useruploads")
            .match((f) => f.uploadedBy.eq(objectIdParam(userId)))
            .group((f) => ({
                _id: ALLOWED_UPLOAD_TYPES.reduceRight<TypedAggExpr<StringField>>(
                    (otherwise, { mimeType, category }) =>
                        fn.cond(
                            fn.eq(f.mimeType, fn.literal(mimeType)).node,
                            fn.literal(category),
                            otherwise
                        ),
                    fn.literal("document")
                ),
                bytes: acc.sum(f.fileSize),
                count: acc.count()
            }))
            .build()
    ) as Promise<{ _id: UploadCategory; bytes: number; count: number }[]>;

export const getUploadTotalsByVisibility = () =>
    runQuery(
        db.query
            .from("useruploads")
            .group((f) => ({
                _id: stringOperator("$ifNull", f.visibility, fn.literal("private")),
                bytes: acc.sum(f.fileSize),
                count: acc.count()
            }))
            .build()
    ) as Promise<{ _id: UploadVisibility; bytes: number; count: number }[]>;

export const deleteUploadById = (id: string) => db.orm.useruploads.where({ id }).delete();

export const deleteUploadsByUser = (userId: unknown): Promise<number> =>
    db.orm.useruploads.where({ uploadedBy: String(userId) }).deleteAndCount();
