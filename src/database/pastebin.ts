import { MongoFieldFilter, MongoFilterExpr, MongoOrExpr } from "@prisma/orm-mongo/query-ast";
import { fn } from "@prisma/orm-mongo/query-builder";

import { SortOrder } from "./userUploads";
import { findUserIdsByUsernamePart } from "./users";
import { db } from "../prisma/db";
import {
    containsIgnoringCase,
    countOf,
    objectIdParam,
    ownerLookup,
    runQuery,
    stringOperator
} from "../helpers/prisma";
import {
    PASTE_LANGUAGE_MAX_LENGTH,
    PASTE_LANGUAGE_MIN_LENGTH,
    PASTE_MAX_LENGTH,
    PASTE_MIN_LENGTH,
    PASTE_PREVIEW_LENGTH
} from "../constants/limits";

export const pasteLanguagePattern: RegExp = new RegExp(
    `^[a-z0-9+#-]{${PASTE_LANGUAGE_MIN_LENGTH},${PASTE_LANGUAGE_MAX_LENGTH}}$`
);

export const pasteSortFields = ["addedOn"] as const;

export type PasteSortField = (typeof pasteSortFields)[number];

export interface PasteListOptions {
    limit: number;
    page: number;
    sortBy: PasteSortField;
    sortOrder: SortOrder;
}

export interface AdminPasteListOptions extends PasteListOptions {
    q?: string;
}

export interface NewPaste {
    content: string;
    language?: string;
    addedBy: unknown;
}

const assertPasteLanguage = (language: string | undefined): void => {
    if (language !== undefined && !pasteLanguagePattern.test(language)) {
        throw new Error("Paste validation failed: invalid language");
    }
};

const assertNewPaste = ({ content, language, addedBy }: NewPaste): void => {
    if (
        typeof content !== "string" ||
        content.length < PASTE_MIN_LENGTH ||
        content.length > PASTE_MAX_LENGTH ||
        !addedBy
    ) {
        throw new Error("Paste validation failed: invalid content or owner");
    }

    assertPasteLanguage(language);
};

export const countPastesByUser = (userId: unknown): Promise<number> =>
    countOf(
        db.query
            .from("pastebins")
            .match((f) => f.addedBy.eq(objectIdParam(userId)))
            .count("n")
            .build()
    );

export const countPastes = (): Promise<number> =>
    countOf(db.query.from("pastebins").count("n").build());

export const createNewPaste = (values: NewPaste) => {
    assertNewPaste(values);

    return db.orm.pastebins.create({
        content: values.content,
        language: values.language,
        addedBy: String(values.addedBy),
        addedOn: new Date()
    });
};

export const findPasteById = (id: string) => db.orm.pastebins.where({ id }).first();

export type Paste = NonNullable<Awaited<ReturnType<typeof findPasteById>>>;

export const findPasteWithOwner = (id: string) =>
    db.orm.pastebins.where({ id }).include("owner").first();

export const updatePasteById = (id: string, values: { language: string }) => {
    assertPasteLanguage(values.language);

    return db.orm.pastebins.where({ id }).update({ language: values.language });
};

export const findPastesByUsername = (
    userId: unknown,
    { limit, page, sortBy, sortOrder }: PasteListOptions
) => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;

    return db.orm.pastebins
        .where({ addedBy: String(userId) })
        .orderBy({ [sortBy]: sortDirection, id: sortDirection })
        .offset((page - 1) * limit)
        .limit(limit)
        .include("owner")
        .all();
};

export const deletePasteById = (id: string) => db.orm.pastebins.where({ id }).delete();

export const deletePastesByUser = (userId: unknown): Promise<number> =>
    db.orm.pastebins.where({ addedBy: String(userId) }).deleteAndCount();

const pasteSearchFilter = async (q: string): Promise<MongoFilterExpr> =>
    MongoOrExpr.of([
        MongoFieldFilter.in("addedBy", (await findUserIdsByUsernamePart(q)).map(objectIdParam)),
        containsIgnoringCase("language", q)
    ]);

export const findPastesWithOwners = async ({
    limit,
    page,
    sortBy,
    sortOrder,
    q
}: AdminPasteListOptions) => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const pastes = db.query.from("pastebins");
    const matchingPastes = q ? pastes.match(await pasteSearchFilter(q)) : pastes;

    return Promise.all([
        runQuery(
            matchingPastes
                .sort({ [sortBy]: sortDirection, _id: sortDirection })
                .skip((page - 1) * limit)
                .limit(limit)
                .pipe(ownerLookup("addedBy"))
                .project((f) => ({
                    language: 1 as const,
                    preview: stringOperator(
                        "$substrCP",
                        f.content,
                        fn.literal(0),
                        fn.literal(PASTE_PREVIEW_LENGTH)
                    ),
                    addedOn: 1 as const,
                    ownerId: fn.arrayElemAt(f.rawPath("owner._id"), fn.literal(0)),
                    ownerUsername: fn.arrayElemAt(f.rawPath("owner.username"), fn.literal(0))
                }))
                .build()
        ),
        countOf(matchingPastes.count("n").build())
    ]);
};

export type PasteWithOwner = Awaited<ReturnType<typeof findPastesWithOwners>>[0][number];
