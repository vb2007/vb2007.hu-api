import mongoose from "mongoose";
import { escapeRegExp, isNull, isPlainObject, isUndefined, mapValues, omitBy } from "lodash";
import { ObjectId } from "@prisma/orm-mongo/bson";
import { fn } from "@prisma/orm-mongo/query-builder";
import type {
    FieldAccessor,
    ModelNestedShape,
    ModelToDocShape,
    UpdaterResult
} from "@prisma/orm-mongo/query-builder";
import {
    MongoAddFieldsStage,
    MongoAggAccumulator,
    MongoAggArrayFilter,
    MongoAggFieldRef,
    MongoAggLiteral,
    MongoAggOperator,
    MongoCountStage,
    MongoExistsExpr,
    MongoExprFilter,
    MongoFieldFilter,
    MongoFilterExpr,
    MongoGroupStage,
    MongoLimitStage,
    MongoLookupStage,
    MongoMatchStage,
    MongoOrExpr,
    MongoPipelineStage,
    MongoProjectStage,
    MongoSkipStage,
    MongoSortStage
} from "@prisma/orm-mongo/query-ast/execution";
import type { MongoValue } from "@prisma/orm-mongo/value";

import { db } from "../prisma/db";
import { allOf, caseInsensitive, firstOf, idIs, objectIdOf, runQuery } from "../helpers/prisma";
import type { Contract, UserAuthenticationOutput } from "../prisma/contract.d";
import { SortOrder } from "./userUploads";
import {
    CodeFailuresSchema,
    EmailChangeSchema,
    EmailCodeSchema,
    countUnclaimedTry,
    failureCountingClaim
} from "./emailCodes";
import { EmailCode, codeFailuresWindowStart } from "../helpers/emailCodes";
import { Passkey, PasskeySchema } from "./passkeys";
import {
    EMAIL_CODE_MAX_ATTEMPTS,
    OWNER_SEARCH_MAX_USERS,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH
} from "../constants/limits";
import { hashSessionToken, isValidEmail } from "../helpers";

export const userSortFields = ["usedBytes", "username", "createdAt"] as const;

export type UserSortField = (typeof userSortFields)[number];

export interface UserListOptions {
    limit: number;
    page: number;
    sortBy: UserSortField;
    sortOrder: SortOrder;
    q?: string;
}

type Stored<T> = T extends Date
    ? T
    : T extends readonly (infer E)[]
      ? Stored<E>[]
      : T extends object
        ? { -readonly [K in keyof T]: Stored<T[K]> }
        : T;

export interface User {
    _id: string;
    username: string;
    email: string;
    authentication: Stored<UserAuthenticationOutput>;
    githubId?: string;
    githubLogin?: string;
    uploadQuotaBytes?: number | null;
    suspendedAt?: Date | null;
    createdAt?: Date;
}

export interface UserWithUploadUsage {
    _id: string;
    username: string;
    email: string;
    createdAt?: Date;
    uploadQuotaBytes?: number | null;
    suspendedAt?: Date | null;
    uploadUsage: { usedBytes: number; count: number };
}

export type UserFields = FieldAccessor<
    ModelToDocShape<Contract, "User">,
    ModelNestedShape<Contract, "User">
>;

const withoutNulls = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(withoutNulls)
        : isPlainObject(value)
          ? omitBy(mapValues(value as object, withoutNulls), isNull)
          : value;

export const toUser = (row: object | null | undefined): User | null => {
    if (!row) {
        return null;
    }

    const { id, _id, ...user } = withoutNulls(row) as Record<string, unknown>;

    return { ...user, _id: String(_id ?? id), authentication: user.authentication ?? {} } as User;
};

const users = () => db.query.from("users");

export const findUser = async (...filters: MongoFilterExpr[]): Promise<User | null> =>
    toUser(
        await firstOf(
            users()
                .match(allOf(...filters))
                .limit(1)
                .build()
        )
    );

export const userExists = async (...filters: MongoFilterExpr[]): Promise<boolean> =>
    Boolean(
        await firstOf(
            users()
                .match(allOf(...filters))
                .limit(1)
                .project("_id")
                .build()
        )
    );

export const updateUser = (filter: MongoFilterExpr, update: (f: UserFields) => UpdaterResult) =>
    firstOf(users().match(filter).updateOne(update));

export const findAndUpdateUser = async (
    filter: MongoFilterExpr,
    update: (f: UserFields) => UpdaterResult,
    returnDocument: "before" | "after"
): Promise<User | null> =>
    toUser(await firstOf(users().match(filter).findOneAndUpdate(update, { returnDocument })));

const isValidUsername = (username: string): boolean =>
    username.length >= USERNAME_MIN_LENGTH && username.length <= USERNAME_MAX_LENGTH;

export const usernameCollator: Intl.Collator = new Intl.Collator("en", { sensitivity: "accent" });

export interface ExpiringHash {
    hash: string;
    expiresAt: Date;
}

export const usernameCollation: mongoose.mongo.CollationOptions = { locale: "en", strength: 2 };

const ExpiringHashSchema = new mongoose.Schema(
    {
        hash: { type: String, required: true },
        expiresAt: { type: Date, required: true }
    },
    { _id: false }
);

const MfaChallengeSchema = new mongoose.Schema(
    {
        hash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        attempts: { type: Number, default: 0 },
        github: { id: String, login: String },
        email: { hash: String, linkHash: String }
    },
    { _id: false }
);

const MfaTotpSetupSchema = new mongoose.Schema(
    {
        secret: { type: String, required: true },
        session: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        attempts: { type: Number, default: 0 }
    },
    { _id: false }
);

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        minlength: USERNAME_MIN_LENGTH,
        maxlength: USERNAME_MAX_LENGTH,
        trim: true
    },
    email: {
        type: String,
        required: true,
        validate: {
            validator: function (this: mongoose.Document, email: string): boolean {
                return !this.isModified("email") || isValidEmail(email);
            }
        },
        unique: true
    },
    authentication: {
        password: {
            type: String,
            select: false //for avoiding fetching sensitive user credentials by accident
        },
        salt: {
            type: String,
            select: false
        },
        sessionToken: {
            type: String,
            select: false
        },
        sessionExpiresAt: {
            type: Date,
            select: false
        },
        githubVerifiedAt: {
            type: Date,
            select: false
        },
        emailVerifiedAt: {
            type: Date,
            select: false
        },
        passwordReset: {
            type: EmailCodeSchema,
            select: false
        },
        passwordResetFailures: {
            type: CodeFailuresSchema,
            select: false
        },
        emailChange: {
            type: EmailChangeSchema,
            select: false
        },
        emailChangeFailures: {
            type: CodeFailuresSchema,
            select: false
        },
        passwordResetLinks: {
            type: [ExpiringHashSchema],
            default: undefined,
            select: false
        },
        githubLink: {
            type: ExpiringHashSchema,
            select: false
        },
        mfaEmail: {
            type: Boolean,
            select: false
        },
        mfaEmailSentAt: {
            type: Date,
            select: false
        },
        mfaEmailSends: {
            type: CodeFailuresSchema,
            select: false
        },
        mfaChallenge: {
            type: MfaChallengeSchema,
            select: false
        },
        mfaFailures: {
            type: CodeFailuresSchema,
            select: false
        },
        mfaTotpSecret: {
            type: String,
            select: false
        },
        mfaTotpLastStep: {
            type: Number,
            select: false
        },
        mfaTotpSetup: {
            type: MfaTotpSetupSchema,
            select: false
        },
        passkeys: {
            type: [PasskeySchema],
            default: undefined,
            select: false
        },
        mfaRecoveryCodes: {
            type: [String],
            default: undefined,
            select: false
        },
        securityNotices: {
            type: CodeFailuresSchema,
            select: false
        }
    },
    githubId: {
        type: String,
        unique: true,
        sparse: true
    },
    githubLogin: {
        type: String
    },
    uploadQuotaBytes: {
        type: Number,
        default: null,
        select: false
    },
    suspendedAt: {
        type: Date,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

UserSchema.index({ username: 1 }, { unique: true, collation: usernameCollation });
UserSchema.index(
    { "authentication.passkeys.credentialId": 1 },
    {
        unique: true,
        partialFilterExpression: { "authentication.passkeys.credentialId": { $exists: true } }
    }
);

export const UserModel = mongoose.model("User", UserSchema);

export const getUserByEmail = async (email: string): Promise<User | null> =>
    toUser(await db.orm.users.where({ email }).first());

const usernameIgnorables: RegExp = /[‍︎️\u{E0020}-\u{E007F}]/gu;
const anyUsernameIgnorables: string = "[‍︎️\u{E0020}-\u{E007F}]*";

const usernamePattern = (username: string): string =>
    [...username.replace(usernameIgnorables, "")].reduce(
        (pattern: string, character: string): string =>
            `${pattern}${escapeRegExp(character)}${anyUsernameIgnorables}`,
        `^${anyUsernameIgnorables}`
    ) + "$";

export const getUserByUsername = async (username: string): Promise<User | null> => {
    const candidates = await runQuery(
        users()
            .match(
                MongoFieldFilter.of(
                    "username",
                    "$regex",
                    caseInsensitive(usernamePattern(username))
                )
            )
            .build()
    );

    return toUser(
        candidates.find(
            (candidate): boolean => usernameCollator.compare(candidate.username, username) === 0
        )
    );
};

export const getUserByGithubId = async (githubId: string): Promise<User | null> =>
    toUser(await db.orm.users.where({ githubId }).first());

export const activeSessionFilter = (sessionToken: string): MongoFilterExpr =>
    allOf(
        MongoFieldFilter.eq("authentication.sessionToken", hashSessionToken(sessionToken)),
        MongoFieldFilter.gt("authentication.sessionExpiresAt", new Date()),
        MongoFieldFilter.eq("suspendedAt", null)
    );

export const getUserBySessionToken = (sessionToken: string): Promise<User | null> =>
    findUser(activeSessionFilter(sessionToken));

export const getUserById = async (id: string): Promise<User | null> =>
    toUser(await db.orm.users.where({ id }).first());

export const countUsers = async (): Promise<number> =>
    (await firstOf(users().count("count").build()))?.count ?? 0;

export const getUserUploadQuota = async (id: { toString(): string }): Promise<User | null> =>
    toUser(
        await db.orm.users
            .where({ id: id.toString() })
            .select("id", "username", "email", "createdAt", "uploadQuotaBytes", "suspendedAt")
            .first()
    );

export const getUserDetails = getUserById;

const uploadUsageStages: MongoPipelineStage[] = [
    new MongoLookupStage({
        from: "useruploads",
        let_: { userId: MongoAggFieldRef.of("_id") },
        pipeline: [
            new MongoMatchStage(
                MongoExprFilter.of(
                    MongoAggOperator.of("$eq", [
                        MongoAggFieldRef.of("uploadedBy"),
                        MongoAggFieldRef.of("$userId")
                    ])
                )
            ),
            new MongoGroupStage(null, {
                bytes: MongoAggAccumulator.sum(MongoAggFieldRef.of("fileSize")),
                count: MongoAggAccumulator.sum(MongoAggLiteral.of(1))
            })
        ],
        as: "uploadGroups"
    }),
    new MongoAddFieldsStage({
        "uploadUsage.usedBytes": MongoAggOperator.of(
            "$sum",
            MongoAggFieldRef.of("uploadGroups.bytes")
        ),
        "uploadUsage.count": MongoAggOperator.of("$sum", MongoAggFieldRef.of("uploadGroups.count"))
    })
];

const userListSortKeys: Record<UserSortField, string> = {
    usedBytes: "uploadUsage.usedBytes",
    username: "usernameKey",
    createdAt: "createdAt"
};

export const findUsersWithUploadUsage = async ({
    limit,
    page,
    sortBy,
    sortOrder,
    q
}: UserListOptions): Promise<[UserWithUploadUsage[], number]> => {
    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;

    const pageStages: MongoPipelineStage[] = [
        new MongoSortStage({ [userListSortKeys[sortBy]]: sortDirection, _id: sortDirection }),
        new MongoSkipStage((page - 1) * limit),
        new MongoLimitStage(limit)
    ];

    const userStages: MongoPipelineStage[] =
        sortBy === "usedBytes"
            ? [...uploadUsageStages, ...pageStages]
            : [...pageStages, ...uploadUsageStages];

    const qPattern: MongoValue = caseInsensitive(escapeRegExp(q));
    const matching = q
        ? users().match(
              MongoOrExpr.of([
                  MongoFieldFilter.of("username", "$regex", qPattern),
                  MongoFieldFilter.of("email", "$regex", qPattern)
              ])
          )
        : users();

    const [{ users: listed, total }] = (await runQuery(
        matching
            .pipe(
                new MongoAddFieldsStage({
                    createdAt: MongoAggOperator.of("$ifNull", [
                        MongoAggFieldRef.of("createdAt"),
                        MongoAggOperator.of("$toDate", MongoAggFieldRef.of("_id"))
                    ]),
                    usernameKey: MongoAggOperator.toLower(MongoAggFieldRef.of("username"))
                })
            )
            .facet({
                users: [
                    ...userStages,
                    new MongoProjectStage({
                        _id: 1,
                        username: 1,
                        email: 1,
                        createdAt: 1,
                        uploadQuotaBytes: 1,
                        suspendedAt: 1,
                        uploadUsage: 1
                    })
                ],
                total: [new MongoCountStage("count")]
            })
            .build()
    )) as unknown as { users: UserWithUploadUsage[]; total: { count: number }[] }[];

    return [listed.map((user) => ({ ...user, _id: String(user._id) })), total[0]?.count ?? 0];
};

export const createUser = async (values: {
    username: string;
    email: string;
    authentication: Partial<User["authentication"]>;
    githubId?: string;
    githubLogin?: string;
}): Promise<User> => {
    const username: string = values.username.trim();

    if (!isValidUsername(username) || !isValidEmail(values.email)) {
        throw new Error("User validation failed");
    }

    const user = omitBy(
        {
            _id: new ObjectId(),
            ...values,
            username,
            uploadQuotaBytes: null,
            suspendedAt: null,
            createdAt: new Date()
        },
        isUndefined
    );

    await runQuery(users().insertOne(user as Record<string, MongoValue>));

    return toUser(user);
};

export const deleteUserById = (id: string): Promise<number> =>
    db.orm.users.where({ id }).deleteAndCount();

export const renameUser = async (id: string, username: string) => {
    const trimmed: string = username.trim();

    if (!isValidUsername(trimmed)) {
        throw new Error("User validation failed");
    }

    return updateUser(idIs(id), (f) => [f.username.set(trimmed)]);
};

export const setUserUploadQuota = (id: string, uploadQuotaBytes: number | null) =>
    updateUser(idIs(id), (f) => [f.uploadQuotaBytes.set(uploadQuotaBytes)]);

export const unlinkGithub = (id: string) =>
    updateUser(idIs(id), (f) => [f.githubId.unset(), f.githubLogin.unset()]);

export const setUserSession = (id: string, session: ExpiringHash) =>
    updateUser(idIs(id), (f) => [
        f("authentication.sessionToken").set(session.hash),
        f("authentication.sessionExpiresAt").set(session.expiresAt)
    ]);

export const changePasswordAndSession = (
    id: string,
    salt: string,
    password: string,
    session: ExpiringHash
) =>
    updateUser(idIs(id), (f) => [
        f("authentication.salt").set(salt),
        f("authentication.password").set(password),
        f("authentication.sessionToken").set(session.hash),
        f("authentication.sessionExpiresAt").set(session.expiresAt),
        f("authentication.passwordReset").unset(),
        f("authentication.passwordResetLinks").unset(),
        f("authentication.emailChange").unset(),
        f("authentication.mfaChallenge").unset(),
        f("authentication.mfaFailures").unset()
    ]);

export const revokeUserSession = (id: string): Promise<User | null> =>
    findAndUpdateUser(
        idIs(id),
        (f) => [
            f("authentication.sessionToken").unset(),
            f("authentication.sessionExpiresAt").unset(),
            f("authentication.mfaChallenge").unset()
        ],
        "before"
    );

export const isEmailSuspended = (email: string): Promise<boolean> =>
    userExists(MongoFieldFilter.eq("email", email), MongoFieldFilter.neq("suspendedAt", null));

const suspensionClearedFields: string[] = [
    "authentication.sessionToken",
    "authentication.sessionExpiresAt",
    "authentication.passwordReset",
    "authentication.passwordResetLinks",
    "authentication.emailChange",
    "authentication.githubLink",
    "authentication.mfaChallenge"
];

export const setUserSuspension = (id: string, suspended: boolean) =>
    updateUser(
        suspended ? idIs(id) : allOf(idIs(id), MongoFieldFilter.neq("suspendedAt", null)),
        (f) => [
            f.stage.set({
                suspendedAt: suspended
                    ? MongoAggOperator.of("$ifNull", [
                          MongoAggFieldRef.of("suspendedAt"),
                          MongoAggFieldRef.of("$NOW")
                      ])
                    : MongoAggLiteral.of(null)
            }),
            f.stage.unset(...suspensionClearedFields)
        ]
    );

const githubVerifiedSessionFilter = (
    id: string,
    sessionToken: string,
    githubVerifiedSince: Date
): MongoFilterExpr =>
    allOf(
        idIs(id),
        activeSessionFilter(sessionToken),
        MongoFieldFilter.in("authentication.password", [null, ""]),
        MongoFieldFilter.gte("authentication.githubVerifiedAt", githubVerifiedSince),
        MongoFieldFilter.lte("authentication.githubVerifiedAt", new Date())
    );

export const reauthedSessionFilter = (
    id: string,
    sessionToken: string,
    passwordHash: string | undefined,
    githubVerifiedSince: Date
): MongoFilterExpr =>
    passwordHash
        ? allOf(
              idIs(id),
              activeSessionFilter(sessionToken),
              MongoFieldFilter.eq("authentication.password", passwordHash)
          )
        : githubVerifiedSessionFilter(id, sessionToken, githubVerifiedSince);

export const setPasswordIfUnset = (
    id: string,
    sessionToken: string,
    salt: string,
    password: string,
    githubVerifiedSince: Date
) =>
    updateUser(githubVerifiedSessionFilter(id, sessionToken, githubVerifiedSince), (f) => [
        f("authentication.salt").set(salt),
        f("authentication.password").set(password),
        f("authentication.githubVerifiedAt").unset(),
        f("authentication.mfaChallenge").unset(),
        f("authentication.mfaFailures").unset(),
        f("authentication.passwordReset").unset(),
        f("authentication.passwordResetLinks").unset()
    ]);

export const replacePasswordHash = (
    id: string,
    previousPassword: string,
    salt: string,
    password: string
) =>
    updateUser(
        allOf(idIs(id), MongoFieldFilter.eq("authentication.password", previousPassword)),
        (f) => [f("authentication.salt").set(salt), f("authentication.password").set(password)]
    );

export const deleteGithubVerifiedUser = (
    id: string,
    sessionToken: string,
    githubVerifiedSince: Date
) =>
    firstOf(
        users()
            .match(githubVerifiedSessionFilter(id, sessionToken, githubVerifiedSince))
            .deleteOne()
    );

export const setGithubLinkProof = (id: string, proof: ExpiringHash) =>
    updateUser(idIs(id), (f) => [f("authentication.githubLink").set({ ...proof })]);

export const claimGithubLinkProof = (id: string, sessionTokenHash: string, hash: string) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("authentication.sessionToken", sessionTokenHash),
            MongoFieldFilter.eq("authentication.githubLink.hash", hash),
            MongoFieldFilter.gt("authentication.githubLink.expiresAt", new Date())
        ),
        (f) => [f("authentication.githubLink").unset()]
    );

export const linkGithubAccount = (
    id: string,
    sessionToken: string,
    githubId: string,
    githubLogin: string,
    session: ExpiringHash
) =>
    updateUser(
        allOf(
            idIs(id),
            activeSessionFilter(sessionToken),
            MongoFieldFilter.in("githubId", [null, githubId])
        ),
        (f) => [
            f.githubId.set(githubId),
            f.githubLogin.set(githubLogin),
            f("authentication.githubVerifiedAt").set(new Date()),
            f("authentication.sessionToken").set(session.hash),
            f("authentication.sessionExpiresAt").set(session.expiresAt)
        ]
    );

export const loginGithubAccount = (
    id: string,
    githubId: string,
    githubLogin: string,
    session: ExpiringHash
) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("githubId", githubId),
            MongoFieldFilter.eq("suspendedAt", null)
        ),
        (f) => [
            f.githubLogin.set(githubLogin),
            f("authentication.githubVerifiedAt").set(new Date()),
            f("authentication.sessionToken").set(session.hash),
            f("authentication.sessionExpiresAt").set(session.expiresAt)
        ]
    );

export const passwordResetScope = (id: string, email: string): string =>
    `passwordReset:${id}:${email}`;

export const passwordResetLinkScope = (id: string): string => `passwordResetLink:${id}`;

const restoreEmailCode = (
    id: string,
    field: string,
    code: EmailCode,
    previous: EmailCode | undefined
) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq(`${field}.hash`, code.hash),
            MongoFieldFilter.eq(`${field}.sentAt`, code.sentAt)
        ),
        (f) => [previous ? f.rawPath(field).set({ ...previous }) : f.rawPath(field).unset()]
    );

export const setPasswordReset = (
    id: string,
    email: string,
    code: EmailCode,
    link: ExpiringHash,
    linksKept: number,
    resendBefore: Date
) =>
    findAndUpdateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("email", email),
            MongoFieldFilter.eq("suspendedAt", null),
            MongoOrExpr.of([
                MongoExistsExpr.notExists("authentication.passwordReset"),
                MongoFieldFilter.lte("authentication.passwordReset.sentAt", resendBefore)
            ])
        ),
        (f) => [
            f.stage.set({
                "authentication.passwordReset": MongoAggLiteral.of(code),
                "authentication.passwordResetLinks": MongoAggOperator.of("$slice", [
                    MongoAggOperator.of("$concatArrays", [
                        MongoAggArrayFilter.of(
                            MongoAggOperator.of("$ifNull", [
                                MongoAggFieldRef.of("authentication.passwordResetLinks"),
                                MongoAggLiteral.of([])
                            ]),
                            MongoAggOperator.of("$gt", [
                                MongoAggFieldRef.of("$this.expiresAt"),
                                MongoAggFieldRef.of("$NOW")
                            ]),
                            "this"
                        ),
                        MongoAggLiteral.of([link])
                    ]),
                    MongoAggLiteral.of(-linksKept)
                ])
            })
        ],
        "before"
    );

export const restorePasswordReset = async (
    id: string,
    code: EmailCode,
    link: ExpiringHash,
    previous: EmailCode | undefined
) => {
    await updateUser(idIs(id), (f) => [
        f("authentication.passwordResetLinks").pull({ hash: { $eq: link.hash } })
    ]);
    await restoreEmailCode(id, "authentication.passwordReset", code, previous);
};

export const claimPasswordResetCode = (email: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.passwordReset",
        "authentication.passwordResetFailures"
    );

    return findAndUpdateUser(
        allOf(
            MongoFieldFilter.eq("email", email),
            MongoFieldFilter.gt("authentication.passwordReset.expiresAt", new Date()),
            MongoFieldFilter.lt("authentication.passwordReset.attempts", EMAIL_CODE_MAX_ATTEMPTS),
            belowCap
        ),
        () => countGuess,
        "after"
    );
};

export const countPasswordResetFailure = (email: string) =>
    updateUser(
        allOf(
            MongoFieldFilter.eq("email", email),
            MongoFieldFilter.gt("authentication.passwordReset.sentAt", codeFailuresWindowStart())
        ),
        () => countUnclaimedTry("authentication.passwordResetFailures")
    );

const passwordResetUpdate = (salt: string, password: string) => (f: UserFields) => [
    f("authentication.salt").set(salt),
    f("authentication.password").set(password),
    f("authentication.emailVerifiedAt").set(new Date()),
    f("authentication.passwordReset").unset(),
    f("authentication.passwordResetLinks").unset(),
    f("authentication.passwordResetFailures").unset(),
    f("authentication.emailChange").unset(),
    f("authentication.sessionToken").unset(),
    f("authentication.sessionExpiresAt").unset(),
    f("authentication.mfaChallenge").unset(),
    f("authentication.mfaFailures").unset()
];

export const resetPassword = (id: string, codeHash: string, salt: string, password: string) =>
    updateUser(
        allOf(idIs(id), MongoFieldFilter.eq("authentication.passwordReset.hash", codeHash)),
        passwordResetUpdate(salt, password)
    );

const livePasswordResetLink = (id: string, linkHash: string): MongoFilterExpr =>
    allOf(
        idIs(id),
        MongoFieldFilter.of("authentication.passwordResetLinks", "$elemMatch", {
            hash: { $eq: linkHash },
            expiresAt: { $gt: new Date() }
        })
    );

export const hasPasswordResetLink = (id: string, linkHash: string): Promise<boolean> =>
    userExists(livePasswordResetLink(id, linkHash));

export const resetPasswordWithLink = (
    id: string,
    linkHash: string,
    salt: string,
    password: string
) =>
    findAndUpdateUser(
        livePasswordResetLink(id, linkHash),
        passwordResetUpdate(salt, password),
        "before"
    );

export const emailChangeScope = (id: string, email: string): string => `emailChange:${id}:${email}`;

export type EmailChange = EmailCode & { email: string };

export const setEmailChange = (
    id: string,
    sessionToken: string,
    passwordHash: string,
    change: EmailChange,
    resendBefore: Date
) =>
    findAndUpdateUser(
        allOf(
            idIs(id),
            activeSessionFilter(sessionToken),
            MongoFieldFilter.eq("authentication.password", passwordHash),
            MongoOrExpr.of([
                MongoExistsExpr.notExists("authentication.emailChange"),
                MongoFieldFilter.lte("authentication.emailChange.sentAt", resendBefore)
            ])
        ),
        (f) => [f("authentication.emailChange").set({ ...change })],
        "before"
    );

export const restoreEmailChange = (
    id: string,
    change: EmailChange,
    previous: EmailChange | undefined
) => restoreEmailCode(id, "authentication.emailChange", change, previous);

export const claimEmailChangeCode = (id: string) => {
    const { belowCap, countGuess } = failureCountingClaim(
        "authentication.emailChange",
        "authentication.emailChangeFailures"
    );

    return findAndUpdateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.gt("authentication.emailChange.expiresAt", new Date()),
            MongoFieldFilter.lt("authentication.emailChange.attempts", EMAIL_CODE_MAX_ATTEMPTS),
            belowCap
        ),
        () => countGuess,
        "after"
    );
};

export const countEmailChangeFailure = (id: string) =>
    findAndUpdateUser(
        idIs(id),
        () => countUnclaimedTry("authentication.emailChangeFailures"),
        "before"
    );

export const uncountEmailChangeFailure = (id: string, since: Date) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("authentication.emailChangeFailures.since", since),
            MongoFieldFilter.gt("authentication.emailChangeFailures.count", 0)
        ),
        (f) => [f("authentication.emailChangeFailures.count").inc(-1)]
    );

export const clearCodeFailures = (email: string) =>
    findAndUpdateUser(
        MongoFieldFilter.eq("email", email),
        (f) => [
            f("authentication.passwordResetFailures").unset(),
            f("authentication.emailChangeFailures").unset(),
            f("authentication.mfaFailures").unset(),
            f("authentication.mfaEmailSends").unset(),
            f("authentication.securityNotices").unset()
        ],
        "before"
    );

export const applyEmailChange = (id: string, codeHash: string, email: string) =>
    updateUser(
        allOf(idIs(id), MongoFieldFilter.eq("authentication.emailChange.hash", codeHash)),
        (f) => [
            f.email.set(email),
            f("authentication.emailVerifiedAt").set(new Date()),
            f("authentication.emailChange").unset(),
            f("authentication.mfaChallenge").unset(),
            f("authentication.passwordReset").unset(),
            f("authentication.passwordResetLinks").unset()
        ]
    );

export const clearEmailChange = (id: string) =>
    updateUser(idIs(id), (f) => [f("authentication.emailChange").unset()]);

export const findUserIdsByUsernamePart = async (q: string): Promise<string[]> =>
    (
        await runQuery(
            users()
                .match(MongoFieldFilter.of("username", "$regex", caseInsensitive(escapeRegExp(q))))
                .addFields((f) => ({ usernameLength: fn.strLenCP(f.username) }))
                .sort({ usernameLength: 1, _id: 1 })
                .limit(OWNER_SEARCH_MAX_USERS)
                .project("_id")
                .build()
        )
    ).map((user): string => String(user._id));

export const findUsernamesByIds = async (ids: { toString(): string }[]) =>
    (
        await runQuery(
            users()
                .match(
                    MongoFieldFilter.in(
                        "_id",
                        ids.map((id) => objectIdOf(id.toString()))
                    )
                )
                .project("username")
                .build()
        )
    ).map(({ _id, username }) => ({ _id: String(_id), username }));

export const getPasskeys = getUserById;

export const getUserByPasskey = (credentialId: string): Promise<User | null> =>
    findUser(MongoFieldFilter.eq("authentication.passkeys.credentialId", credentialId));

export const addPasskey = (
    id: string,
    sessionToken: string,
    passkey: Passkey,
    maxPasskeys: number
) =>
    updateUser(
        allOf(
            idIs(id),
            activeSessionFilter(sessionToken),
            MongoExistsExpr.notExists(`authentication.passkeys.${maxPasskeys - 1}`),
            MongoFieldFilter.neq("authentication.passkeys.credentialId", passkey.credentialId)
        ),
        (f) => [
            f("authentication.passkeys").push({
                ...omitBy(passkey, isUndefined),
                lastUsedAt: passkey.lastUsedAt ?? null
            } as MongoValue)
        ]
    );

const ownPasskey = (id: string, credentialId: string): MongoFilterExpr =>
    allOf(idIs(id), MongoFieldFilter.eq("authentication.passkeys.credentialId", credentialId));

export const renamePasskey = (id: string, credentialId: string, name: string) =>
    updateUser(ownPasskey(id, credentialId), (f) => [
        f.rawPath("authentication.passkeys.$.name").set(name)
    ]);

export const removePasskey = (reauthed: MongoFilterExpr, credentialId: string) =>
    updateUser(
        allOf(reauthed, MongoFieldFilter.eq("authentication.passkeys.credentialId", credentialId)),
        (f) => [f("authentication.passkeys").pull({ credentialId: { $eq: credentialId } })]
    );

export const hasPasskey = (id: string, credentialId: string): Promise<boolean> =>
    userExists(ownPasskey(id, credentialId));

export const usePasskey = (
    id: string,
    credentialId: string,
    counter: number,
    newCounter: number,
    mfaChallengeHash?: string
) =>
    updateUser(
        allOf(
            idIs(id),
            MongoFieldFilter.eq("suspendedAt", null),
            MongoFieldFilter.of("authentication.passkeys", "$elemMatch", {
                credentialId: { $eq: credentialId },
                counter: { $eq: counter }
            }),
            ...(mfaChallengeHash
                ? [
                      MongoFieldFilter.eq("authentication.mfaChallenge.hash", mfaChallengeHash),
                      MongoFieldFilter.gt("authentication.mfaChallenge.expiresAt", new Date())
                  ]
                : [])
        ),
        (f) => [
            f.rawPath("authentication.passkeys.$.counter").set(newCounter),
            f.rawPath("authentication.passkeys.$.lastUsedAt").set(new Date()),
            ...(mfaChallengeHash ? [] : [f("authentication.mfaChallenge").unset()])
        ]
    );
