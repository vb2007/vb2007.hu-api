import mongoose from "mongoose";
import { MongoFieldFilter, MongoFilterExpr } from "@prisma/orm-mongo/query-ast/execution";
import type { MongoValue } from "@prisma/orm-mongo/value";

import { db } from "../prisma/db";
import { whenKey } from "./users";
import { allOf, containsIgnoringCase, countOf, firstOf, idIs, runQuery } from "../helpers/prisma";

import { EMAIL_CODE_MAX_ATTEMPTS } from "../constants/limits";
import {
    CodeFailuresSchema,
    EmailCodeSchema,
    countUnclaimedTry,
    failureCountingClaim
} from "./emailCodes";
import { EmailCode } from "../helpers/emailCodes";

export interface PendingRegistration {
    email: string;
    code: EmailCode;
    expiresAt: Date;
}

export const registrationCodeScope = (email: string): string => `registration:${email}`;

const PendingRegistrationSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true
    },
    code: {
        type: EmailCodeSchema,
        required: true
    },
    failures: {
        type: CodeFailuresSchema
    },
    expiresAt: {
        type: Date,
        required: true,
        expires: 0
    }
});

export const PendingRegistrationModel = mongoose.model(
    "PendingRegistration",
    PendingRegistrationSchema
);

const pendingRegistrations = () => db.query.from("pendingregistrations");

const emailIs = (email: string): MongoFilterExpr => MongoFieldFilter.eq("email", email);

const notExpired = (): MongoFilterExpr => MongoFieldFilter.gt("expiresAt", new Date());

const expired = (): MongoFilterExpr => MongoFieldFilter.lte("expiresAt", new Date());

const countPending = async (filter: MongoFilterExpr): Promise<number> =>
    countOf(pendingRegistrations().match(filter).count("n").build());

export const getPendingRegistration = (email: string) =>
    whenKey(email, () => firstOf(pendingRegistrations().match(emailIs(email)).limit(1).build()));

export const countPendingRegistrations = (): Promise<number> => countPending(notExpired());

export const savePendingRegistration = async (values: PendingRegistration, resendBefore: Date) => {
    await firstOf(
        pendingRegistrations()
            .match(allOf(emailIs(values.email), expired()))
            .deleteOne()
    );

    return firstOf(
        pendingRegistrations()
            .match(allOf(emailIs(values.email), MongoFieldFilter.lte("code.sentAt", resendBefore)))
            .findOneAndUpdate(
                (f) => [
                    f.email.set(values.email),
                    f.code.set({ ...values.code }),
                    f.expiresAt.set(values.expiresAt),
                    f.rawPath("username").unset(),
                    f.rawPath("authentication").unset()
                ],
                { upsert: true, returnDocument: "before" }
            )
    );
};

export type StoredPendingRegistration = Awaited<ReturnType<typeof savePendingRegistration>>;

export const replacePendingRegistrationCode = (
    email: string,
    code: EmailCode,
    resendBefore: Date
) =>
    firstOf(
        pendingRegistrations()
            .match(
                allOf(
                    emailIs(email),
                    MongoFieldFilter.lte("code.sentAt", resendBefore),
                    notExpired()
                )
            )
            .findOneAndUpdate((f) => [f.code.set({ ...code })], { returnDocument: "before" })
    );

const withCode = (email: string, code: EmailCode): MongoFilterExpr =>
    allOf(
        emailIs(email),
        MongoFieldFilter.eq("code.hash", code.hash),
        MongoFieldFilter.eq("code.sentAt", code.sentAt)
    );

export const restorePendingRegistration = (
    email: string,
    code: EmailCode,
    previous: StoredPendingRegistration
) =>
    previous
        ? firstOf(
              pendingRegistrations()
                  .match(withCode(email, code))
                  .updateOne((f) => [
                      f.code.set({ ...previous.code }),
                      f.expiresAt.set(previous.expiresAt)
                  ])
          )
        : firstOf(pendingRegistrations().match(withCode(email, code)).deleteOne());

export const restorePendingRegistrationCode = (
    email: string,
    code: EmailCode,
    previous: EmailCode
) =>
    firstOf(
        pendingRegistrations()
            .match(withCode(email, code))
            .updateOne((f) => [f.code.set({ ...previous })])
    );

export const takePendingRegistration = (email: string, code: EmailCode) =>
    firstOf(
        pendingRegistrations()
            .match(allOf(withCode(email, code), notExpired()))
            .findOneAndDelete()
    );

export const reinstatePendingRegistration = (pending: StoredPendingRegistration) =>
    firstOf(
        pendingRegistrations()
            .match(emailIs(pending.email))
            .upsertOne((f) =>
                Object.entries(pending).map(([key, value]) =>
                    f.rawPath(key).setOnInsert(value as MongoValue)
                )
            )
    );

export const claimPendingRegistrationCode = (email: string) => {
    const { belowCap, countGuess } = failureCountingClaim("code", "failures");

    return firstOf(
        pendingRegistrations()
            .match(
                allOf(
                    emailIs(email),
                    notExpired(),
                    MongoFieldFilter.gt("code.expiresAt", new Date()),
                    MongoFieldFilter.lt("code.attempts", EMAIL_CODE_MAX_ATTEMPTS),
                    belowCap
                )
            )
            .findOneAndUpdate(() => countGuess, { returnDocument: "after" })
    );
};

export const countPendingRegistrationFailure = (email: string) =>
    firstOf(
        pendingRegistrations()
            .match(allOf(emailIs(email), notExpired()))
            .findOneAndUpdate(() => countUnclaimedTry("failures"), { returnDocument: "before" })
    );

export const uncountPendingRegistrationFailure = (email: string, since: Date) =>
    firstOf(
        pendingRegistrations()
            .match(
                allOf(
                    emailIs(email),
                    MongoFieldFilter.eq("failures.since", since),
                    MongoFieldFilter.gt("failures.count", 0)
                )
            )
            .updateOne((f) => [f("failures.count").inc(-1)])
    );

export const clearPendingRegistrationFailures = (email: string) =>
    firstOf(
        pendingRegistrations()
            .match(allOf(emailIs(email), notExpired()))
            .findOneAndUpdate((f) => [f.failures.unset()], { returnDocument: "before" })
    );

export const deletePendingRegistration = (email: string) =>
    firstOf(pendingRegistrations().match(emailIs(email)).deleteOne());

export interface PendingRegistrationListOptions {
    limit: number;
    page: number;
    q?: string;
}

export const findPendingRegistrations = ({ limit, page, q }: PendingRegistrationListOptions) => {
    const filter: MongoFilterExpr = allOf(
        notExpired(),
        ...(q ? [containsIgnoringCase("email", q)] : [])
    );

    return Promise.all([
        runQuery(
            pendingRegistrations()
                .match(filter)
                .sort({ expiresAt: -1, _id: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .project("email", "expiresAt")
                .build()
        ),
        countPending(filter)
    ]);
};

export const deletePendingRegistrationById = (id: string) =>
    firstOf(
        pendingRegistrations()
            .match(allOf(idIs(id), notExpired()))
            .deleteOne()
    );
