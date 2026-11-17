import {
    MongoAddFieldsStage,
    MongoAggCond,
    MongoAggExpr,
    MongoAggFieldRef,
    MongoAggLiteral,
    MongoAggOperator,
    MongoFieldFilter,
    MongoFilterExpr,
    MongoOrExpr
} from "@prisma/orm-mongo/query-ast/execution";

import { CODE_FAILURES_PER_DAY } from "../constants/limits";
import { codeFailuresWindowStart } from "../helpers/emailCodes";

const failureRef = (failuresField: string, key: string): MongoAggFieldRef =>
    MongoAggFieldRef.of(`${failuresField}.${key}`);

const isCountingSince = (failuresField: string, windowStart: Date): MongoAggExpr =>
    MongoAggOperator.of("$gt", [
        failureRef(failuresField, "since"),
        MongoAggLiteral.of(windowStart)
    ]);

export const countedFailures = (
    failuresField: string,
    windowStart: Date,
    keepIf?: MongoAggExpr
): Record<string, MongoAggExpr> => {
    const counting: MongoAggExpr = isCountingSince(failuresField, windowStart);
    const keptOr = (key: string, counted: MongoAggExpr): MongoAggExpr =>
        keepIf ? MongoAggCond.of(keepIf, failureRef(failuresField, key), counted) : counted;

    return {
        [`${failuresField}.count`]: keptOr(
            "count",
            MongoAggCond.of(
                counting,
                MongoAggOperator.of("$add", [
                    failureRef(failuresField, "count"),
                    MongoAggLiteral.of(1)
                ]),
                MongoAggLiteral.of(1)
            )
        ),
        [`${failuresField}.since`]: keptOr(
            "since",
            MongoAggCond.of(
                counting,
                failureRef(failuresField, "since"),
                MongoAggLiteral.of(new Date())
            )
        )
    };
};

export const belowFailureCap = (
    failuresField: string,
    cap: number,
    windowStart: Date
): MongoFilterExpr =>
    MongoOrExpr.of([
        MongoFieldFilter.of(`${failuresField}.count`, "$not", { $gte: cap }),
        MongoFieldFilter.lte(`${failuresField}.since`, windowStart)
    ]);

export const failureCountingClaim = (codeField: string, failuresField: string) => {
    const windowStart: Date = codeFailuresWindowStart();

    return {
        belowCap: belowFailureCap(failuresField, CODE_FAILURES_PER_DAY, windowStart),
        countGuess: [
            new MongoAddFieldsStage({
                [`${codeField}.attempts`]: MongoAggOperator.of("$add", [
                    MongoAggFieldRef.of(`${codeField}.attempts`),
                    MongoAggLiteral.of(1)
                ]),
                ...countedFailures(failuresField, windowStart)
            })
        ]
    };
};

export const countUnclaimedTry = (failuresField: string): MongoAddFieldsStage[] => {
    const windowStart: Date = codeFailuresWindowStart();
    const capped: MongoAggExpr = MongoAggOperator.of("$and", [
        isCountingSince(failuresField, windowStart),
        MongoAggOperator.of("$gte", [
            failureRef(failuresField, "count"),
            MongoAggLiteral.of(CODE_FAILURES_PER_DAY)
        ])
    ]);

    return [new MongoAddFieldsStage(countedFailures(failuresField, windowStart, capped))];
};
