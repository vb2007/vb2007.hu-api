# Migrations

Migrations change existing data when a release needs it, e.g. moving files or filling in a new field. They live in `src/migrations/` and run in the order of the `migrations` list in `src/migrations/index.ts`. Each one is recorded by name in the `migrations` collection once it succeeds, so it runs only once.

> **Never run them locally.** The local `.env` (and CI's) points at the production database, so there is deliberately no `yarn` script for them.

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
5. Test it on a record of your own in `src/tests/migrations.test.ts`, never through its full function, which would touch every record in the production database.

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
