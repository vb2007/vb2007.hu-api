# Prisma ORM

The API is moving from Mongoose to Prisma ORM 8 (`@prisma/orm-mongo`, the MongoDB build of Prisma 8; Prisma 7 has no MongoDB support). For now both run side by side: Prisma serves users, sessions, MFA, passkeys and pending registrations, `/healthz` and shutdown, and Mongoose the rest. This page is the reference for porting the data layer.

## Files

| File | What it is |
|---|---|
| `src/prisma/contract.prisma` | Hand-written contract (PSL) for all 7 collections, exactly as they're stored. Its first line must stay `// use prisma-8`. |
| `src/prisma/contract.json`, `contract.d.ts` | Emitted from the contract, committed. Never edit them by hand. |
| `src/prisma/db.ts` | The client: `export const db = mongo({ contract, url: process.env.DB_CONNECTION_STRING })`. It connects lazily on the first query. |
| `prisma.config.ts` | Tells the CLI where the contract is. The CLI needs no database. |
| `src/helpers/prisma.ts` | `validateObjectId`, `isObjectId`, `newObjectId`, `isDuplicateKeyError`, `isDuplicateKeyOn`, `isDatabaseReachable`. These replace `src/helpers/mongoose.ts`. Also the builder shorthands `runQuery`/`firstOf` (run a plan, get all rows or the first), `idIs`/`objectIdOf` (an `_id` filter or value from a hex id), `allOf` (`$and`) and `caseInsensitive` (a regex value). |

After changing `contract.prisma`, run this and commit all three files:

```shell
yarn prisma contract emit
```

CI runs it too and fails if the committed `contract.json` or `contract.d.ts` differ from what it emits.

**Never run `prisma db update`, `db sign`, `db migrate` or `migration apply`.** They install strict `$jsonSchema` validators that reject the fields the contract doesn't declare (`__v` on old documents), which would break writes. Indexes stay with our own migrations (`docs/migrations.md`).

## Query policy

1. **`db.orm.<collection>`**: CRUD on top-level fields.
2. **`db.query.from("<collection>")`** (the pipeline builder) for anything the ORM can't express: filters on embedded fields, `$inc`/`$pull`/`$setOnInsert`, update pipelines, `findOneAndUpdate` with `returnDocument`, upserts, `$lookup`/`$group`/`$count` aggregations.
3. **`db.raw.collection(...)` or `db.query.rawCommand(...)`** only when neither of those can express the query (positional `$` updates, arbitrary pipelines). Raw queries go only in `src/database/*` and the migration runner.

Mongoose and direct `mongodb` driver queries are going away, in the tests too. `ObjectId` values are fine; import them from `@prisma/orm-mongo/bson`. Keep the HTTP responses identical: the frontend reads `_id`, while the ORM names the field `id` (see below).

Run builder and raw plans on the runtime:

```ts
const runtime = await db.runtime();
const rows = await runtime.query(plan);
```

`runtime.query` returns an `AsyncIterableResult`: `await` it for an array, or call `.first()`.

## Gotchas

- **A hex string never matches an `ObjectId` in builder or raw filters, and fails silently with no match and no error.** In builder filters pass `MongoParamRef.of(new ObjectId(id))` (`MongoParamRef` from `@prisma/orm-mongo/value`; a bare `ObjectId` works at runtime but doesn't type-check), in raw filters `new ObjectId(id)`. The ORM is the opposite: it takes and returns ids as hex strings (`where({ id })`, `create({ addedBy: user.id })`).
- **Embedded paths in the builder are a call, not a property:** `f("authentication.mfaChallenge.hash")`, type-checked against the contract. `f.rawPath("...")` skips the check.
- **Values inside `fn.*` expressions must be wrapped:** `fn.literal(1)`, `fn.literal(date)`. Pass an expression's `.node` where a stage or `fn.cond` condition expects a raw expression.
- **Result id types depend on the API:**

  | API | `_id` and ObjectId refs come back as |
  |---|---|
  | `db.orm` (also `include`d relations) | hex `string`, under the contract name `id` |
  | builder, only `match`/`sort`/`limit`/`skip`/`project`/`addFields` stages | hex `string`, under `_id` |
  | builder with `group`/`lookup`/other stages, and builder `findOneAndUpdate` | `ObjectId`, under `_id` |
  | `db.raw` | `ObjectId`, under `_id` |

- **No collation on queries.** No runtime command has a collation, hint or `arrayFilters` option; collation exists only for index creation. `getUserByUsername` fetches candidates with an anchored, case-insensitive regex that skips the collation-ignorable characters a valid username may hold (zero-width joiners, emoji presentation selectors, tag characters), then keeps the one `usernameCollator` (`{ sensitivity: "accent" }`, as `usernameFormatError` uses) calls equal. Residual edge: names the `{ locale: "en", strength: 2 }` index treats as equal but the regex doesn't match (canonically equivalent NFC/NFD forms, full-width or other compatibility letters) aren't found by the lookup, so `isUsernameTaken` passes them; the unique collated index still rejects the insert or rename with 11000, which the callers answer with 409. `$toLower` doesn't reproduce the collation's order (accented letters and `ß` land after `z`, `_` after digits), so the admin user list sorted by username fetches the matching `_id`s and usernames, sorts them with `usernameCollator` (ties on `_id`), and loads only that page's users.
- **No `select: false`.** Reads return every declared field, `authentication` included, unless you `.select(...)` the ones you need. Never send a row to a client unprojected.
- **Missing and `null` read the same.** A missing optional field reads as `null`; a missing list is left out of the row. Undeclared fields (`__v`) are dropped on read. `where({ field: null })` matches null or missing, like Mongo.
- **Builder reads fill missing fields with `null`, embedded ones too; `findOneAndUpdate`/`findOneAndDelete` return the stored document as is.** `toUser` in `src/database/users.ts` turns any user row into the Mongoose-like shape the routes use: `_id` as a hex string, `null`s dropped, `authentication` at least `{}`. Write a stored document back (`reinstatePendingRegistration`) only from a `findOneAndDelete`/`findOneAndUpdate` result, never from a decoded read.
- **Builder and raw writes store `undefined` as `null`** (Mongoose dropped it). Leave undefined fields out of `set`/`push`/`insertOne` values; a stray `githubId: null` would also break the sparse unique index.
- **An empty `allOf()` lowers to `$and: []`, which MongoDB rejects.** Skip the `match` instead.
- **Positional `$` updates, `$$NOW` and `$$REMOVE` work in the builder:** `f.rawPath("authentication.passkeys.$.counter").set(n)`, `MongoAggFieldRef.of("$NOW")`, `MongoAggFieldRef.of("$REMOVE")`. The users port needs no raw queries.
- **The Mongoose schemas still create the indexes.** Mongoose's `autoIndex` builds the unique, collated, partial and TTL indexes (`expiresAt` on `pendingregistrations` and `passkeychallenges`) from the schemas, so the ported files keep their schema and model until the migrations own the indexes.
- **`create` leaves unset optional fields out of the document**, so the sparse `githubId` index keeps working. `update({ field: null })` stores `null`; `update((u) => [u.field.unset()])` removes the field. Use `unset()` for `githubId`.
- **An ORM `update` of an embedded object replaces the whole object.** To change one embedded field, use the builder: `f("authentication.mfaChallenge.attempts").inc(1)`.
- **`inc` isn't typed on nullable numbers in ORM update callbacks.** Use the builder there.
- **`await runtime.query(plan)` is needed for every builder and raw plan.** Building one runs nothing.
- **`owner` is typed non-null but reads `null` for an orphaned reference** (dev has one paste whose user was deleted). PSL refuses `User?` on a required foreign key, so check for `null` yourself.
- **Counting:** there's no `countDocuments`/`estimatedDocumentCount`; use `db.query.from(c).match(...).count("n").build()`.
- **No runtime DDL found yet:** `rawCommand` takes CRUD and aggregate commands only. `@prisma/orm-mongo/query-ast` also exports `CreateIndexCommand`, `DropIndexCommand`, `DropCollectionCommand`, `ListIndexesCommand` and `ListCollectionsCommand`, but the driver runs those through the migration tooling's control plane; whether our runner can use them without the strict validators is unverified. `$indexStats` in a raw aggregate lists indexes. The migration runner and the test cleanup need a plan for this when Mongoose goes.
- **`db.close()` is single-shot.** Every later query rejects with "Mongo client is closed". Shutdown closes it together with Mongoose, once the server has stopped and pending work has settled.
- **Two `bson` versions run side by side while both ORMs do:** Mongoose uses bson 6, Prisma bson 7. An `ObjectId` from one passed into the other's queries throws `BSONVersionError` ("Unsupported BSON version"). Pass hex strings across, or convert with `new ObjectId(id.toHexString())` using the target's `ObjectId`.
- **`/healthz`** runs `isDatabaseReachable()`, a one-document read of `migrations`. While the database is unreachable a query waits for the driver's server selection timeout (30 s) before failing.
- **Transactions need a replica set.** Prisma ORM has none on MongoDB yet. Everything else above works on our standalone `mongod`.

## Mongoose patterns and their Prisma equivalents

Field names in `db.orm` are contract names (`id`); in the builder and raw they're stored names (`_id`).

**Find one, find by id, select:**

```ts
await db.orm.users.where({ email }).first();
await db.orm.users.where({ id }).select("username", "email").first();
```

**Create, then answer with `_id`:**

```ts
const paste = await db.orm.pastebins.create({ content, addedBy: user.id, addedOn: new Date() });
res.json({ _id: paste.id, ...rest });
```

**Update or delete one / many:**

```ts
await db.orm.pastebins.where({ id }).update({ content });
await db.orm.pastebins.where({ addedBy: userId }).deleteAndCount();
```

**Populate (`addedBy` to owner):**

```ts
await db.orm.pastebins.where({ id }).include("owner").first();
```

**Filter on an embedded field, then `$inc` it, returning the document after:**

```ts
const [user] = await runtime.query(
    db.query
        .from("users")
        .match((f) => f("authentication.mfaChallenge.hash").eq(hash))
        .findOneAndUpdate((f) => [f("authentication.mfaChallenge.attempts").inc(1)], {
            returnDocument: "after"
        })
);
```

**Update pipeline (`$set` with `$cond`/`$add`), returning the document before:**

```ts
import { ObjectId } from "@prisma/orm-mongo/bson";
import { fn } from "@prisma/orm-mongo/query-builder";
import { MongoParamRef } from "@prisma/orm-mongo/value";

db.query
    .from("users")
    .match((f) => f._id.eq(MongoParamRef.of(new ObjectId(id))))
    .findOneAndUpdate(
        (f) => [
            f.stage.set({
                "authentication.mfaFailures.count": fn.cond(
                    fn.gte(f("authentication.mfaFailures.since"), fn.literal(since)).node,
                    fn.add(f("authentication.mfaFailures.count"), fn.literal(1)),
                    fn.literal(1)
                ).node
            })
        ],
        { returnDocument: "before" }
    );
```

Operator updates (`set`/`inc`/`unset`/`push`/`pull`/`setOnInsert`...) and pipeline stages (`f.stage.set`/`unset`/`replaceRoot`) can't be mixed in one update.

**`$pull` by condition from an embedded array:**

```ts
db.query
    .from("users")
    .match((f) => f._id.eq(MongoParamRef.of(new ObjectId(id))))
    .updateOne((f) => [f("authentication.passkeys").pull({ credentialId })]);
```

**Upsert with `$setOnInsert`:**

```ts
db.query
    .from("passkeychallenges")
    .match((f) => f._id.eq(idHash))
    .upsertOne((f) => [f.challenge.setOnInsert(challenge), f.expiresAt.set(expiresAt)]);
```

**Positional update (`arr.$.field`), raw:**

```ts
db.raw
    .collection("users")
    .updateOne(
        { _id: new ObjectId(id), "authentication.passkeys.credentialId": credentialId },
        { $set: { "authentication.passkeys.$.counter": counter } }
    )
    .build();
```

## Duplicate keys

Every write path (ORM `create`/`update`, builder and raw) throws the driver's own `MongoServerError` unchanged, with `code: 11000`, `keyPattern` (e.g. `{ email: 1 }`) and `keyValue`. So `isDuplicateKeyOn(error, "email")` works as before.

## Ids

- `isObjectId(id)` / `validateObjectId(id, res)` accept exactly 24 hex characters. Mongoose's `ObjectId.isValid` also accepted any 12-character string.
- `newObjectId()` returns a new id as a hex string, for when the id is needed before the insert. Pass it to `create({ id })`.
- `passkeychallenges` has a string `_id` (`id String @id`).

## Numbers

`uploadQuotaBytes`, `fileSize` and passkey `counter` are `Double`, because values above the 32-bit range exist (production has a 500 GiB quota). Counters and attempts are `Int32`. Decoding is lenient: existing int32 and double values read fine through either type.

## Jest and CommonJS

The app is CommonJS; `@prisma/orm-mongo` is ESM-only. Node 24 loads it with `require()`, so `tsc` output, `ts-node` and the Docker image need nothing extra, and `contract.json` reaches `dist/` through `resolveJsonModule`. Jest 29 has its own module loader without that support, so `jest.config.js` transpiles the Prisma packages and their ESM dependencies (`arktype` and friends) with ts-jest. It also transpiles `mongodb/lib/runtime_adapters.js`, whose `import("os")` Jest can't run without `--experimental-vm-modules`. Without that, every connection fails its handshake with "Missing required sub-document 'driver' in the client metadata document". Add any other ESM-only package the client starts pulling in to `transformIgnorePatterns`.
