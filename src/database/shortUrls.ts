import mongoose from "mongoose";
import {
    MongoAndExpr,
    MongoFieldFilter,
    MongoFilterExpr,
    MongoOrExpr
} from "@prisma/orm-mongo/query-ast";
import { fn } from "@prisma/orm-mongo/query-builder";

import { findUserIdsByUsernamePart } from "./users";
import { SHORT_URL_MAX_LENGTH } from "../constants/limits";
import { SortOrder } from "./userUploads";
import { db } from "../prisma/db";
import {
    containsIgnoringCase,
    countOf,
    objectIdParam,
    ownerLookup,
    runQuery
} from "../helpers/prisma";

export const shortUrlSortFields = ["addedOn"] as const;

export type ShortUrlSortField = (typeof shortUrlSortFields)[number];

export interface ShortUrlListOptions {
    limit: number;
    page: number;
    sortBy: ShortUrlSortField;
    sortOrder: SortOrder;
    q?: string;
}

const ShortUrlSchema = new mongoose.Schema({
    originalUrl: {
        type: String,
        required: true,
        minlength: 4,
        maxlength: SHORT_URL_MAX_LENGTH
    },
    shortenedUrl: {
        type: String,
        required: true,
        unique: true
    },
    addedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    addedOn: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

ShortUrlSchema.index({ originalUrl: 1, addedBy: 1 }, { unique: true });
ShortUrlSchema.index({ addedBy: 1, addedOn: -1, _id: -1 });
ShortUrlSchema.index({ addedOn: -1, _id: -1 });

export const ShortUrlModel = mongoose.model("ShortUrls", ShortUrlSchema);

export interface NewShortUrl {
    originalUrl: string;
    shortenedUrl: string;
    addedBy: unknown;
}

const assertNewShortUrl = ({ originalUrl, shortenedUrl, addedBy }: NewShortUrl): void => {
    if (
        typeof originalUrl !== "string" ||
        originalUrl.length < 4 ||
        originalUrl.length > SHORT_URL_MAX_LENGTH ||
        typeof shortenedUrl !== "string" ||
        !shortenedUrl ||
        !addedBy
    ) {
        throw new Error("Short URL validation failed: invalid URL, code or owner");
    }
};

export const getOriginalUrl = (shortenedUrl: string) =>
    db.orm.shorturls.where({ shortenedUrl }).first();

export const getOriginalUrlWithUser = (shortenedUrl: string) =>
    db.orm.shorturls.where({ shortenedUrl }).include("owner").first();

export const getShortUrlByUser = (originalUrl: string, userId: unknown) =>
    db.orm.shorturls.where({ originalUrl, addedBy: String(userId) }).first();

export const countShortUrls = (): Promise<number> =>
    countOf(db.query.from("shorturls").count("n").build());

const findShortUrlPage = (
    filter: MongoFilterExpr | undefined,
    { limit, page, sortBy, sortOrder }: ShortUrlListOptions
) => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const shortUrls = db.query.from("shorturls");
    const matchingShortUrls = filter ? shortUrls.match(filter) : shortUrls;

    return {
        page: matchingShortUrls
            .sort({ [sortBy]: sortDirection, _id: sortDirection })
            .skip((page - 1) * limit)
            .limit(limit),
        total: countOf(matchingShortUrls.count("n").build())
    };
};

const shortUrlTextFilter = (q: string): MongoFilterExpr[] => [
    containsIgnoringCase("shortenedUrl", q),
    containsIgnoringCase("originalUrl", q)
];

export const findShortUrlsByUser = async (userId: unknown, options: ShortUrlListOptions) => {
    const ownerFilter: MongoFilterExpr = MongoFieldFilter.eq("addedBy", objectIdParam(userId));
    const { page, total } = findShortUrlPage(
        options.q
            ? MongoAndExpr.of([ownerFilter, MongoOrExpr.of(shortUrlTextFilter(options.q))])
            : ownerFilter,
        options
    );
    const [shortUrls, count] = await Promise.all([runQuery(page.build()), total]);

    return [
        shortUrls.map(({ originalUrl, shortenedUrl, addedOn }) => ({
            originalUrl,
            shortenedUrl,
            addedOn
        })),
        count
    ] as const;
};

export const countShortUrlsByUser = (userId: unknown): Promise<number> =>
    countOf(
        db.query
            .from("shorturls")
            .match((f) => f.addedBy.eq(objectIdParam(userId)))
            .count("n")
            .build()
    );

export const createShortUrl = (values: NewShortUrl) => {
    assertNewShortUrl(values);

    return db.orm.shorturls.create({
        originalUrl: values.originalUrl,
        shortenedUrl: values.shortenedUrl,
        addedBy: String(values.addedBy),
        addedOn: new Date()
    });
};

export const deleteByShortUrl = (shortenedUrl: string) =>
    db.orm.shorturls.where({ shortenedUrl }).delete();

export const deleteShortUrlsByUser = (userId: unknown): Promise<number> =>
    db.orm.shorturls.where({ addedBy: String(userId) }).deleteAndCount();

const shortUrlSearchFilter = async (q: string): Promise<MongoFilterExpr> =>
    MongoOrExpr.of([
        ...shortUrlTextFilter(q),
        MongoFieldFilter.in("addedBy", (await findUserIdsByUsernamePart(q)).map(objectIdParam))
    ]);

export const findShortUrls = async (options: ShortUrlListOptions) => {
    const { page, total } = findShortUrlPage(
        options.q ? await shortUrlSearchFilter(options.q) : undefined,
        options
    );

    return Promise.all([
        runQuery(
            page
                .pipe(ownerLookup("addedBy"))
                .project((f) => ({
                    shortenedUrl: 1 as const,
                    originalUrl: 1 as const,
                    addedOn: 1 as const,
                    ownerId: fn.arrayElemAt(f.rawPath("owner._id"), fn.literal(0)),
                    ownerUsername: fn.arrayElemAt(f.rawPath("owner.username"), fn.literal(0))
                }))
                .build()
        ),
        total
    ]);
};

export type ShortUrlWithOwner = Awaited<ReturnType<typeof findShortUrls>>[0][number];
