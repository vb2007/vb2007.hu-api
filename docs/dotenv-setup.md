# Config values in .env

Before starting the application itself for running unit tests, make sure the `.env` file's filled out correctly.

## Creating the file

Create the `.env` file in the project's root directory:

```shell
cp .env.example .env
nano .env
```

## Required variables


| Variable | What it is | Example |
| --- | --- | --- |
| `APP_IP` | API host/IP to bind | `localhost` |
| `APP_PORT` | API port number | `3000` |
| `COOKIE_TARGET_DOMAIN` | Domain of the `VB-AUTH` login cookie. In production it's the parent domain (`vb2007.hu`, not `api.vb2007.hu`), so the browser also sends it to `cdn.vb2007.hu` for private uploads | `localhost` |
| `DB_CONNECTION_STRING` | MongoDB connection URL | `mongodb://localhost:27017/vb2007` |
| `CORS_ORIGIN_URLS` | Allowed frontend origins (comma separated) | `http://localhost:5173,https://api.example.com` |
| `CRYPTO_SECRET_KEY` | Secret key for crypto/token work | `verySecret_@nd_comp1ex_K€y` |
| `BASE_SITE_URL` | Main website URL | `https://vb2007.hu` |
| `CDN_URL` | CDN origin without a path, upload URLs are `<CDN_URL>/useruploads/<userId>/<uploadId><ext>` | `https://cdn.vb2007.hu` |
| `UPLOAD_DISK_DIRECTORY` | Folder for uploaded files, stored as `<userId>/<uploadId><ext>`, should be an absolute path (a relative one resolves from the working directory) | `/tmp/uploads` |
| `UPLOAD_MAX_FILESIZE` | Upload size limit in MB, defaults to `100` if missing or not a positive integer | `10` |
| `UPLOAD_USER_QUOTA_MB` | Storage quota per user in MB, defaults to `10240` if missing or not a positive integer. A user's `uploadQuotaBytes` field overrides it when set | `10240` |
| `SUPERUSER_EMAIL` | E-mail of the superuser, matched trimmed and case-insensitive. An e-mail rather than a username because usernames can be changed. Empty or missing means there is no superuser | `admin@example.com` |
| `TEST_EMAIL` | Test user email | `testuser@example.com` |
| `TEST_USERNAME` | Test user name | `testuser` |
| `TEST_PASSWORD` | Test user password | `testpasswd` |

## GitHub login variables

Optional: GitHub login is off without them. See [github-oauth-setup](./github-oauth-setup.md).

| Variable | What it is | Example |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID | `Ov23li...` |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret | `0123abcd...` |
| `GITHUB_CALLBACK_URL` | The app's authorization callback URL, pointing at the API | `http://localhost:3000/auth/github/callback` |

## Docker-only variables

Only read by `compose.yaml` (see the [README](../README.md#docker)). Compose sets `APP_PORT` and `UPLOAD_DISK_DIRECTORY` inside the container itself.

| Variable | What it is | Example |
| --- | --- | --- |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token (Zero Trust > Networks > Tunnels) | `eyJhIjoi...` |
| `UPLOADS_DIR` | Host folder mounted as the upload directory, writable by uid `1000`. In production it's `/mnt/raid1/cdn/useruploads`, which the cdn's nginx (root `/mnt/raid1/cdn`) serves at `/useruploads/` | `./uploads` |
