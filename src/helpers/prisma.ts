import express from "express";
import { get } from "lodash";
import { ObjectId } from "@prisma/orm-mongo/bson";

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
