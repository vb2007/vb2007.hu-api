# Migrations

Migrations change the database when a release needs it, e.g. creating an index or filling in a new field. They live in `src/migrations/` and run in the order of the `migrations` list in `src/migrations/index.ts`. Each one is recorded by name in the `migrations` collection once it succeeds, so it runs only once.

> **Never run them against production by hand.** Only the deploy applies them to the production database, and CI to its own `vb2007hu-ci` database before each test run. A hand run is one wrong `.env` away from production, so there is deliberately no `yarn` script for them. Test them in `src/tests/migrations.test.ts`. The local `.env` points at the `vb2007hu-dev` database, which gets its indexes the same way (see [the dev database](#the-dev-database)).

CI applies the migrations of the PR branch it tests, so a migration that changes later in its PR stays recorded in `vb2007hu-ci` in its first form. Give the changed version a new name, or remove its record from `vb2007hu-ci` by hand.

## On deploy

The deploy job (`.github/workflows/release.yml`) runs them automatically, after pulling the new image and before restarting the stack:

```sh
docker compose run --rm --no-deps api node dist/migrate.js
```

That uses the new image with the api's `.env`, uploads volume and read-only/`cap_drop` settings. It prints `Applied <name>` per migration, or `No pending migrations`. If one fails, the deploy stops: the stack isn't restarted, the previous version keeps running, and the failed migration isn't recorded, so the next deploy retries it.

## Adding a migration

1. Add `src/migrations/<number>-<name>.ts`, numbered after the last one (e.g. `011-user-display-names.ts`), exporting an async function that does the work. Never reuse a number or name from the [history](#history).
2. Append `{ name: "<number>-<name>", up: <function> }` to `migrations` in `src/migrations/index.ts`. Don't rename or reorder applied ones: the name is what gets recorded.
3. Keep it:
    - **idempotent**: a failed run may have done part of its work, and the next deploy runs it again;
    - **compatible with the previous release**: the old version keeps running while it runs, and after it if it fails.
4. There are no down migrations. To undo one, add a new migration.
5. Test it on a record of your own in `src/tests/migrations.test.ts`, never through its full function on a real collection, which would touch every record in the database the tests use. A migration that takes its collection names as a parameter can run in full against per-run test collections, like `009-ensure-indexes`.

Data goes through `db` (`src/prisma/db.ts`) as everywhere else. Indexes and collections go through `withControl` (`src/prisma/control.ts`), which runs Prisma's DDL commands (`CreateIndexCommand`, `DropIndexCommand`, `DropCollectionCommand`...) on Prisma's control driver. It doesn't install the contract's `$jsonSchema` validators, unlike `prisma db update` and the other migration commands (see [prisma.md](./prisma.md)).

### Indexes

The indexes are declared in `src/prisma/contract.prisma` (`@@index`/`@@unique` with `map` set to the index's name), apart from `authentication.passkeys.credentialId_1` and `authentication.apiKeys.hash_1`: PSL can't index a path into a composite type yet, so `ensureIndexes` in `009-ensure-indexes` adds them itself. Nothing creates them when the API starts. To add or change one, change the contract and add a migration that creates it, e.g. one that runs `ensureIndexes` again. `009-ensure-indexes` is already recorded, so changing the contract alone does nothing. Dropping or changing an existing index needs its own step with `DropIndexCommand`, since creating an index under a name that exists with other options fails.

## Running them by hand

On the server, in the deploy directory, with the image to run them from (a version or `sha-<commit>`, or set `IMAGE_REF=ghcr.io/vb2007/vb2007.hu-api@<digest>` instead of `IMAGE_TAG`):

```sh
cd /home/vb2007/prod/vb2007.hu-api
IMAGE_TAG=<tag> docker compose run --rm --no-deps api node dist/migrate.js
```

### The dev database

Nothing but the migrations creates indexes, so `vb2007hu-dev` needs them run too, e.g. after a pull that adds one. First check that `.env` points at `vb2007hu-dev`, then run them from a fresh build:

```sh
grep '^DB_CONNECTION_STRING=' .env | grep -q '/vb2007hu-dev?' && yarn build && node dist/migrate.js
```

## 009-ensure-indexes

Mongoose created every index from its schemas when the API started. Prisma doesn't, so this migration creates them all, with the names and options the Mongoose schemas gave them: the contract's indexes for each collection, plus `authentication.passkeys.credentialId_1` (and, since `010-api-key-index`, `authentication.apiKeys.hash_1`) on `users`. Creating an index that exists with the same name and options does nothing, so on a database the Mongoose releases ran against (production, `vb2007hu-dev`, `vb2007hu-ci`) it only adds what's missing, and on a fresh one it creates them all. If an index exists under the same name with other options, MongoDB refuses it (`IndexKeySpecsConflict`), so the migration fails and the deploy stops without dropping or changing anything. Compare that index with the contract, then fix it by hand or with a new migration.

The previous release keeps working while it runs, as it only adds indexes the previous release already has. Running it again changes nothing.

## 010-api-key-index

Runs `ensureIndexes` again, which adds the unique `authentication.apiKeys.hash_1` index on `users` (only on users with API keys, `partialFilterExpression: { $exists: true }`) for [API keys](./api-keys.md) and changes nothing else. On a database where `009-ensure-indexes` runs in the same deploy, 009 already creates it and 010 changes nothing. The previous release doesn't store API keys, so it keeps working while it runs.

## History

Migrations `001` to `008` ran on production through the Mongoose migration runner, before the switch to Prisma, and were then removed. Their names stay recorded in the production `migrations` collection, so don't reuse them.

| Migration | What it did |
| --- | --- |
| `001-upload-storage-layout` | Moved uploads from `<username>/<timestamp>-<random><ext>` to `<userId>/<uploadId><ext>`, updated their records and set a missing `visibility` to `private` |
| `002-normalize-user-emails` | Lower-cased stored e-mails, stopping on e-mails that differed only in case |
| `003-case-insensitive-usernames` | Replaced the case-sensitive `username_1` index with a unique one under the `{ locale: "en", strength: 2 }` collation |
| `004-per-user-short-urls` | Created the unique `originalUrl_1_addedBy_1` index and dropped `originalUrl_1`, so each user gets their own short link for a URL |
| `005-clear-plaintext-session-tokens` | Removed plain-text session tokens stored without an expiry |
| `006-end-shared-domain-sessions` | Ended every session when the cookie became the host-only `__Host-VB-AUTH` |
| `007-wrap-legacy-password-hashes` | Replaced the legacy HMAC password hashes with their scrypt hash under the same salt (`wrapLegacyPasswordHash`) |
| `008-per-user-list-indexes` | Replaced `uploadedBy_1_uploadedOn_-1` and `addedBy_1_addedOn_-1` with `uploadedBy_1_uploadedOn_-1__id_-1` and `addedBy_1_addedOn_-1__id_-1` |
