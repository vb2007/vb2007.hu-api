# Migrations

Migrations change existing data when a release needs it, e.g. moving files or filling in a new field. They live in `src/migrations/` and run in the order of the `migrations` list in `src/migrations/index.ts`. Each one is recorded by name in the `migrations` collection once it succeeds, so it runs only once.

> **Never run them locally.** Only the deploy applies them, recording each one once in the production database, and a hand run is one wrong `.env` away from production, so there is deliberately no `yarn` script for them. Test them in `src/tests/migrations.test.ts` instead. The local `.env` points at the `vb2007hu-dev` database and CI's at the `vb2007hu-ci` database.

## On deploy

The deploy job (`.github/workflows/release.yml`) runs them automatically, after pulling the new image and before restarting the stack:

```sh
docker compose run --rm --no-deps api node dist/migrate.js
```

That uses the new image with the api's `.env`, uploads volume and read-only/`cap_drop` settings. It prints `Applied <name>` per migration, or `No pending migrations`. If one fails, the deploy stops: the stack isn't restarted, the previous version keeps running, and the failed migration isn't recorded, so the next deploy retries it.

## Adding a migration

1. Add `src/migrations/<number>-<name>.ts`, numbered after the last one (e.g. `002-user-display-names.ts`), exporting an async function that does the work.
2. Append `{ name: "<number>-<name>", up: <function> }` to `migrations` in `src/migrations/index.ts`. Don't rename or reorder applied ones: the name is what gets recorded.
3. Keep it:
    - **idempotent**: a failed run may have done part of its work, and the next deploy runs it again;
    - **compatible with the previous release**: the old version keeps running while it runs, and after it if it fails.
4. There are no down migrations. To undo one, add a new migration.
5. Test it on a record of your own in `src/tests/migrations.test.ts`, never through its full function on a real collection, which would touch every record in the database the tests use. A migration that takes its model as a parameter can run in full against a per-run test collection, like `002-normalize-user-emails`.

## Running them by hand

On the server, in the deploy directory, with the image to run them from (a version or `sha-<commit>`):

```sh
cd /home/vb2007/prod/vb2007.hu-api
IMAGE_TAG=<tag> docker compose run --rm --no-deps api node dist/migrate.js
```

## 001-upload-storage-layout

Uploads are stored as `<UPLOAD_DISK_DIRECTORY>/<userId>/<uploadId><ext>` and served at `<CDN_URL>/useruploads/<userId>/<uploadId><ext>`. Uploads made before that live at `<username>/<timestamp>-<random><ext>`, and their records hold that absolute `filePath`.

This migration moves every file to its new path and updates its record (`extension`, `updatedOn`, `storedFileName`, `filePath`). Records whose file can't be found are logged and skipped. Uploads without a `visibility` are set to `private`. Running it again leaves migrated uploads alone.

| Variable | What it is |
| --- | --- |
| `UPLOAD_DISK_DIRECTORY` | The upload folder as the API sees it, `/app/uploads` in the container. New `filePath`s are written under it |
| `LEGACY_UPLOAD_DIRECTORY` | Optional: the old upload folder (the one holding the `<username>` folders), for when a record's `filePath` doesn't exist as is in the container |

If old uploads live outside the uploads folder, run it by hand with the new image before its deploy, with the old folder (writable by uid `1000`) mounted:

```sh
IMAGE_TAG=<tag> docker compose run --rm --no-deps \
  -v <old upload folder>:/legacy -e LEGACY_UPLOAD_DIRECTORY=/legacy \
  api node dist/migrate.js
```

## 002-normalize-user-emails

Register, login and GitHub sign-up store and look up e-mails trimmed and lower-cased, so an e-mail that differs only in case (e.g. from `SUPERUSER_EMAIL`) can't be registered as a second account. This migration lower-cases the e-mails stored before that.

It first checks for users whose e-mails differ only in case. If there are any, it fails without changing anything and lists their ids (one group per `;`), so the deploy stops. Change or delete all but one account of each group by hand, then deploy again. Running it again leaves normalized e-mails alone.

## 003-case-insensitive-usernames

Register, `PATCH /users/:id` and GitHub sign-up treat usernames that differ only in case as the same, and the unique `username_1` index enforces it with a case-insensitive collation. This migration replaces the old case-sensitive `username_1` index with that one. Until it has run, the API starts as usual but can't create the new index (it has the same name), so only the taken-checks compare case-insensitively.

It first checks for users whose usernames differ only in case. If there are any, it fails without changing anything and lists their ids (one group per `;`), so the deploy stops. Rename or delete all but one account of each group by hand, then deploy again. If the new index can't be created (e.g. the running release stored a clash in the meantime), it puts the old one back and fails. Running it again leaves the new index alone.

## 004-per-user-short-urls

`POST /shortenUrl/create` dedupes short URLs per user, so each user gets their own short link for a URL, and the unique `originalUrl_1_addedBy_1` index enforces it. This migration creates that index, then drops the old `originalUrl_1` index, which kept a URL unique across all users. Until it has run, the API starts as usual and creates the new index, but shortening a URL another user already has answers `500`, as the old index still rejects it.

The previous release keeps working while it runs, since it never relies on the old index being gone. Running it again leaves the new index alone.

Anything that starts with the previous schema (the previous release restarting, a rollback, or CI on a branch without this change) creates `originalUrl_1` again through mongoose autoIndex, as long as no URL is shared across users yet. Before the deploy that's fine, as this migration drops it. Once it's recorded, nothing drops it again, and shortening a URL another user already has answers `500`. Drop it by hand in `mongosh` on the server:

```js
db.shorturls.dropIndex("originalUrl_1")
```

## 005-clear-plaintext-session-tokens

Sessions store only the sha256 of the `VB-AUTH` token, next to `authentication.sessionExpiresAt`, and expire after 7 days (see the [README](../README.md#account-rules)). Tokens stored before that are plain text without an expiry. They no longer log anyone in, since a raw token hashes to something else, but this migration removes them so no plain-text token stays in the database. Everyone logged in before the deploy logs in again once.

The previous release keeps working while it runs: its users with a plain-text token are logged out, and the ones it logs in meanwhile get a new plain-text token, which this run may miss. Those log in nobody under the new release either, and the next login replaces them. Running it again only clears tokens stored without an expiry, so hashed sessions stay.
