import express from "express";
import { escapeRegExp, get } from "lodash";
import { ObjectId } from "@prisma/orm-mongo/bson";
import {
    MongoAggOperator,
    MongoFieldFilter,
    MongoFilterExpr,
    MongoLookupStage,
    MongoProjectStage,
    MongoQueryPlan
} from "@prisma/orm-mongo/query-ast";
import { DocField, StringField, TypedAggExpr } from "@prisma/orm-mongo/query-builder";
import { MongoParamRef } from "@prisma/orm-mongo/value";

import { Responses } from "../constants/responses";
import { db } from "../prisma/db";

const objectIdPattern: RegExp = /^[0-9a-f]{24}$/i;

export const isObjectId = (id: unknown): id is string =>
    typeof id === "string" && objectIdPattern.test(id);

export const validateObjectId = (id: unknown, res: express.Response): id is string => {
    if (!isObjectId(id)) {
        res.status(400).json({
            error: Responses.Mongoose.invalidIdFormat
        });
        return false;
    }
    return true;
};

export const newObjectId = (): string => new ObjectId().toHexString();

export const objectIdParam = (id: unknown): MongoParamRef =>
    MongoParamRef.of(new ObjectId(String(id)));

export const containsIgnoringCase = (field: string, text: string): MongoFilterExpr =>
    MongoFieldFilter.of(field, "$regex", MongoParamRef.of(new RegExp(escapeRegExp(text), "i")));

export const stringOperator = (
    op: string,
    ...args: TypedAggExpr<DocField>[]
): TypedAggExpr<StringField> => ({
    _field: { codecId: "mongo/string@1", nullable: false },
    node: MongoAggOperator.of(
        op,
        args.map(({ node }) => node)
    )
});

export const ownerLookup = (localField: string): MongoLookupStage =>
    new MongoLookupStage({
        from: "users",
        localField,
        foreignField: "_id",
        as: "owner",
        pipeline: [new MongoProjectStage({ username: 1 })]
    });

export const runQuery = async <Row>(plan: MongoQueryPlan<Row>): Promise<Row[]> =>
    (await db.runtime()).query(plan);

export const countOf = async (plan: MongoQueryPlan<{ n: number }>): Promise<number> =>
    (await runQuery(plan))[0]?.n ?? 0;

export const isDuplicateKeyError = (error: unknown): boolean =>
    (error as { code?: number })?.code === 11000;

export const isDuplicateKeyOn = (error: unknown, field: string): boolean =>
    isDuplicateKeyError(error) && Boolean(get(error, ["keyPattern", field]));

export const isDatabaseReachable = (): Promise<boolean> =>
    db.orm.migrations
        .select("id")
        .first()
        .then(
            (): boolean => true,
            (error: Error): boolean => {
                console.error(`Prisma database check failed: ${error.message}`);
                return false;
            }
        );
