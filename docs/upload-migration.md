# Migrating uploads to the new storage layout

Uploads are stored as `<UPLOAD_DISK_DIRECTORY>/<userId>/<uploadId><ext>` and served at `<CDN_URL>/useruploads/<userId>/<uploadId><ext>`. Uploads made before that live at `<username>/<timestamp>-<random><ext>` in the old systemd deploy's upload folder, and their records hold that absolute `filePath`.

`scripts/migrate-uploads.ts` moves every file to its new path and updates its record (`extension`, `updatedOn`, `storedFileName`, `filePath`). Records whose file can't be found are logged and skipped. Uploads without a `visibility` are set to `private`. Running it again is safe: already migrated uploads are left alone.

| Variable | What it is |
| --- | --- |
| `DB_CONNECTION_STRING` | The database to migrate |
| `UPLOAD_DISK_DIRECTORY` | The upload folder **as the API sees it**. The script writes paths under it into `filePath`, so in production it has to be the container path, `/app/uploads` |
| `LEGACY_UPLOAD_DIRECTORY` | Optional: the old upload folder (the one holding the `<username>` folders), for when a record's `filePath` doesn't exist as is, e.g. because the old folder is mounted somewhere else |

## Running it on the server

Run it right after the first release with the new layout is deployed: until then, old uploads' URLs point to files that aren't there yet.

The runtime image only has `dist/`, so the script runs from a checkout in a one-off Node container, with the uploads folder (`UPLOADS_DIR`, `/mnt/raid1/cdn/useruploads` in production) mounted at `/app/uploads` like in `compose.yaml`, and the old upload folder at `/legacy`. The container reads the database settings from the deploy directory's `.env`. Old `filePath` values show where the old folder is: it's the parent of the `<username>` folders.

```sh
git clone --depth 1 https://github.com/vb2007/vb2007.hu-api.git /tmp/vb2007.hu-api-migrate
cd /tmp/vb2007.hu-api-migrate

docker run --rm --user node \
  -v "$PWD":/src -w /src \
  -v /home/vb2007/prod/vb2007.hu-api/.env:/src/.env:ro \
  -v /mnt/raid1/cdn/useruploads:/app/uploads \
  -v <old upload folder>:/legacy \
  -e UPLOAD_DISK_DIRECTORY=/app/uploads \
  -e LEGACY_UPLOAD_DIRECTORY=/legacy \
  node:24.22-alpine \
  sh -c "yarn install --frozen-lockfile && yarn migrate-uploads"
```

It prints every moved file and a summary, e.g. `Uploads: 12, migrated: 12, already migrated: 0, missing file: 0` and `Uploads set to private: 12`. Run the same command again to check: it should report `migrated: 0` and `Uploads set to private: 0`. Then remove the checkout (`rm -rf /tmp/vb2007.hu-api-migrate`) and, once the uploads load fine from the cdn, the old upload folder.
