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
| `APP_IP` | Address the API listens on, all interfaces if unset. `compose.yaml` sets it to `0.0.0.0` inside the container | `127.0.0.1` |
| `APP_PORT` | API port number | `3000` |
| `DB_CONNECTION_STRING` | MongoDB connection URL. Locally (development and `yarn test`) it's the `vb2007hu-dev` database, see [mongodb-deb13-setup](./db/mongodb-deb13-setup.md#8-dev-database--user); only the deploy's `.env` points at production | `mongodb://vb2007hu-dev:<password>@192.168.x.x:27017/vb2007hu-dev?authSource=vb2007hu-dev` |
| `CORS_ORIGIN_URLS` | Allowed frontend origins (comma separated). Spaces around the entries are trimmed and empty entries ignored; the API refuses to start if it's missing or has no origins | `http://localhost:5173,https://api.example.com` |
| `CRYPTO_SECRET_KEY` | Secret key for crypto/token work, also signs private upload URLs | `verySecret_@nd_comp1ex_K€y` |
| `BASE_SITE_URL` | Main website URL: GitHub login redirects back to it, and password reset mails link to its `/reset-password` page | `https://vb2007.hu` |
| `CDN_URL` | CDN origin without a path, upload URLs are `<CDN_URL>/useruploads/<userId>/<uploadId><ext>`, signed for private uploads (see [cdn-setup](./cdn-setup.md)) | `https://cdn.vb2007.hu` |
| `UPLOAD_DISK_DIRECTORY` | Folder for uploaded files, stored as `<userId>/<uploadId><ext>`, should be an absolute path (a relative one resolves from the working directory) | `/tmp/uploads` |
| `UPLOAD_MAX_FILESIZE` | Upload size limit in MB, defaults to `100` if missing or not a positive integer in plain decimal digits (no `0x10`, `1e3`, signs or spaces) whose byte count is a safe integer | `10` |
| `UPLOAD_USER_QUOTA_MB` | Storage quota per user in MB, defaults to `10240` if missing or not a positive integer in plain decimal digits (no `0x10`, `1e3`, signs or spaces) whose byte count is a safe integer. A user's `uploadQuotaBytes` field overrides it when set | `10240` |
| `SUPERUSER_EMAIL` | E-mail of the superuser, matched trimmed and case-insensitive. E-mails are stored trimmed and lower-cased, so only one account can match it. An e-mail rather than a username because usernames can be changed. Empty or missing means there is no superuser | `admin@example.com` |

## Unit test variables

The tests create their own users, so there is no test user to configure. See [dev-setup](./dev-setup.md#running-the-unit-tests).

| Variable | What it is | Example |
| --- | --- | --- |
| `SUPERUSER_EMAIL` | For `yarn test` it must be a test address ending in `.vb2007.test`: the run registers that account as its superuser and deletes it afterwards. Never point it at a real account while testing; the tests refuse to start otherwise | `superuser@local.vb2007.test` |
| `TEST_RUN_ID` | Optional tag for the run's test data (e-mails are `<username>@<TEST_RUN_ID>.vb2007.test`). It's a domain label, so only letters, digits and hyphens: with anything else (e.g. `local_1`) every registration test fails. CI sets it to `<run id>-<attempt>`; a random one is used when empty | `local1` |

## GitHub login variables

Optional: GitHub login is off without them, and `yarn test` skips its tests. See [github-oauth-setup](./github-oauth-setup.md).

| Variable | What it is | Example |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID | `Ov23li...` |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret | `0123abcd...` |
| `GITHUB_CALLBACK_URL` | The app's authorization callback URL, pointing at the API | `http://localhost:3000/auth/github/callback` |

## Mail variables

Optional, see [email-setup](./email-setup.md). Without `SMTP_HOST` and `MAIL_FROM` no mail is sent: the API logs a warning and, outside production (`NODE_ENV` isn't `production`), prints the mail with its code instead. Mail to reserved test domains (`.test`, `.example`, `.invalid`, `.localhost`) is never sent.

| Variable | What it is | Example |
| --- | --- | --- |
| `SMTP_HOST` | SMTP server | `smtp-relay.brevo.com` |
| `SMTP_PORT` | SMTP port, defaults to `587` (STARTTLS); `465` uses implicit TLS | `587` |
| `SMTP_USER` | SMTP login | `9a1b2c001@smtp-brevo.com` |
| `SMTP_PASSWORD` | SMTP password (Brevo: an SMTP key) | `xsmtpsib-...` |
| `MAIL_FROM` | Sender, must be a verified sender or domain at the SMTP provider | `vb2007.hu <noreply@vb2007.hu>` |
| `MAIL_DAILY_LIMIT` | E-mails sent per UTC day at most, defaults to `250` if missing or not a positive integer in plain decimal digits (no `0x10`, `1e3`, signs or spaces). A fifth of it is kept for mail to existing accounts, so registration codes stop once the day's count of all mail reaches the other four fifths, and password reset codes once it reaches the limit less a tenth (rounded up). Keep it below the provider's daily cap, see [Brevo's quota](./email-setup.md#brevos-quota) | `250` |

## Docker-only variables

Only read by `compose.yaml` (see the [README](../README.md#docker)). Compose sets `APP_IP`, `APP_PORT` and `UPLOAD_DISK_DIRECTORY` inside the container itself.

| Variable | What it is | Example |
| --- | --- | --- |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token (Zero Trust > Networks > Tunnels) | `eyJhIjoi...` |
| `UPLOADS_DIR` | Host folder mounted as the upload directory, writable by uid `1000`. In production it's `/mnt/raid1/cdn/useruploads`, which the cdn's nginx (root `/mnt/raid1/cdn`) serves at `/useruploads/` | `./uploads` |
