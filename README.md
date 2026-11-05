# vb2007.hu-api

<div align="center">

[![Release & Deploy](https://github.com/vb2007/vb2007.hu-api/actions/workflows/release.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/release.yml) [![Docker Build](https://github.com/vb2007/vb2007.hu-api/actions/workflows/docker-build.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/docker-build.yml)

[![API Unit Tests](https://github.com/vb2007/vb2007.hu-api/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/unit-tests.yml) [![CodeQL](https://github.com/vb2007/vb2007.hu-api/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/github-code-scanning/codeql)

</div>

## About

A simple API for my personal website, written with Express.js and some other packages.

This project was made for replacing the first version of my site written in PHP: [vb2007.hu-php](https://github.com/vb2007/vb2007.hu-php)

The API is mainly - but not only - used on the project's frontend: [vb2007.hu-vue](https://github.com/vb2007/vb2007.hu-vue)

Every unexpected error (e.g. the database being down) answers `500` with JSON `{"error": "Something went wrong on the server: please try again later."}`: handlers pass it to `handleRequestError` (`src/middlewares/index.ts`), which logs it and keeps its details out of the response.

### Account rules

- Registering takes two steps, so every account's e-mail address is confirmed. `POST /auth/register` with `{"username", "email", "password"}` checks them as before (`400`, `409` for a taken username), then e-mails a 6 digit code and answers `202`: no account exists yet and nothing but the address and code is stored. An address that already has an account gets the same `202`, so the endpoint doesn't reveal which addresses have accounts. `POST /auth/register/verify` with `{"email", "code", "username", "password"}` checks the username and password again, then creates the account and logs in (`201` with the `VB-AUTH` cookie), or answers `409` when the address already has one; only whoever confirms the code sets the password. Disposable addresses and domains that can't receive mail get `400`. See [email-setup](./docs/email-setup.md#registration).
- Usernames are 2 to 16 characters, stored with whitespace trimmed from both ends and otherwise as given (case, inner spaces and invisible characters are kept), and unique by the `en` strength 2 collation (`usernameCollation` in `src/database/users.ts`). Once `Taken` exists, these count as the same name: another case (`taken`), fullwidth letters (`Ｔaken`), an added zero-width character (e.g. U+200B) or most control characters (e.g. U+0007) anywhere in it, and whitespace at either end, a non-breaking space included. Accents and whitespace inside the name stay distinct: `Takén` is free, and so is `Ta ken` (a space and a non-breaking space count as the same; a tab or line break inside makes yet another name). `POST /auth/register`, `POST /auth/register/verify`, `PATCH /users/:id` and `PATCH /admin/users/:id` answer `409` to a taken name, GitHub sign-up picks a free name by the same rule, and `GET /auth/username-available?username=…` answers `200 {"available": true|false}` by the same rule, so a form can check while it is typed, and `400` outside 2 to 16 characters. Waiting registrations don't hold a name: it is only taken once an account has it, so `POST /auth/register/verify` answers `409` to a name taken meanwhile and the code still works with another one. There is deliberately no e-mail variant: it would reveal which addresses have accounts.
- Passwords are 8 to 128 characters, checked whenever a password is set, by `POST /auth/register`, `POST /auth/register/verify`, `POST /user/password` and `PATCH /user/password` (`passwordLengthError` in `src/helpers/index.ts`); anything else answers `400`. Accounts with a shorter password from before these rules can still log in.
- Passwords are stored as salted scrypt hashes (N=16384, r=8, p=5, 64 byte key) of their HMAC-SHA256 with `CRYPTO_SECRET_KEY`, so a database dump alone isn't enough to guess them, as `scrypt$<N>$<r>$<p>$<hex>`, and checked in constant time (`hashPassword` and `verifyPassword` in `src/helpers/password.ts`). Only hashes with these parameters are accepted, so a tampered hash can't make a check run for long. Hashes from before are a plain HMAC-SHA256: they keep working, and the account's next successful login replaces one with a scrypt hash. If the scrypt parameters ever change, the dummy hash that failed logins check against (`verifyLoginPassword`) should keep the parameters existing accounts still carry until they upgrade, so a failed login takes as long as theirs.
- Hashing runs on libuv's thread pool and takes all but two of its threads at most, so a burst of logins can't hold up file and DNS work. Waiting hashes take turns by salt, so a burst against one account doesn't hold up other users' logins. The image sets `UV_THREADPOOL_SIZE=8` (6 for hashing); without it the pool has 4 threads (2 for hashing).
- `POST /auth/login` with `{"email", "password"}` answers `200` with the `VB-AUTH` cookie, `400` when a field is missing, empty (an e-mail of only whitespace too) or isn't a string, and the same `403` "Incorrect e-mail address or password. If you signed up with GitHub, log in with GitHub." for an unknown address, a wrong password and an account without a password (made with GitHub), so it doesn't reveal which addresses have accounts. Accounts without a password deliberately get no message of their own, since it would reveal that a GitHub account uses the address: the one message points to GitHub login for everyone. Every failed login, including an account that still has the older HMAC hash, runs one scrypt check, against a dummy hash computed at startup when there is no scrypt hash to check (`verifyLoginPassword` in `src/helpers/password.ts`), so they take about as long.
- Logging in (`POST /auth/login`, `POST /auth/register/verify` or GitHub) sets the `VB-AUTH` cookie for 7 days, and the session expires on the server at the same time (`SESSION_MAX_AGE_MS` in `src/constants/limits.ts`); an expired or unknown token gets `403`. Only the token's sha256 is stored (`authentication.sessionToken`, next to `authentication.sessionExpiresAt`), so a database leak hands out no working sessions. An account has one session at a time: a new login logs out its other devices, and `POST /auth/logout` ends it.
- `PATCH /user/password` with `{"currentPassword": "…", "newPassword": "…"}` changes the logged-in user's password. It answers `400` when a field is missing, isn't a string or the new password breaks the rules, `403` when the current password is wrong and `409` when the account has no password (made with GitHub): set one with `POST /user/password` first. On success it starts a new session: the old `VB-AUTH` cookie stops working and the response sets a fresh one, and any password reset code or link mailed before stops working. A linked GitHub account stays linked.
- `PATCH /user/email` mails a code to the new address and only switches to it after `POST /user/email/confirm` with `{"code"}`; until then `GET /user` shows it as `pendingEmail`. Another account's address and `SUPERUSER_EMAIL` get the same `202` and code, and only `POST /user/email/confirm` refuses them (`409`, or `403` for `SUPERUSER_EMAIL`). See [email-setup](./docs/email-setup.md#e-mail-change).
- A forgotten password is reset by e-mail: `POST /auth/password-reset` with `{"email"}` always answers the same `200` (or `429` over the mail limit) and mails a code and a link if an account uses the address; `POST /auth/password-reset/confirm` with `{"email", "code", "newPassword"}` sets the password, ends every session and mails the account a notice. `POST /auth/password-reset/confirm-link` with `{"token", "newPassword"}` does the same with the token from the link. See [email-setup](./docs/email-setup.md#password-reset).
- `POST /user/password` sets a password on an account made with GitHub after a GitHub login or relink in the last 10 minutes (else `403`), starts a new session the same way and voids any password reset code or link mailed before. See [github-oauth-setup](./docs/github-oauth-setup.md#endpoints).
- `DELETE /user` deletes the logged-in user's account with everything it owns: pastes, short URLs, uploads and their files. Accounts with a password confirm it with `{"password": "…"}`, accounts without one (made with GitHub) with `{"username": "<own username>"}` after a GitHub login or relink in the last 10 minutes from the same session. It answers `400` when that field is missing, empty or isn't a string, and `403` when the password is wrong, the username isn't the account's own or the GitHub confirmation is missing or expired (relink and retry; these refusals delete nothing). See [github-oauth-setup](./docs/github-oauth-setup.md#endpoints). On success it ends the session and clears the `VB-AUTH` cookie.
- Failed password checks are rate-limited per 15 minutes (`src/middlewares/rateLimit.ts`, with the numbers in `src/constants/limits.ts`): `POST /auth/login` allows 10 per e-mail address from one client IP and 100 per e-mail address from all IPs together, `PATCH /user/password`, `PATCH /user/email`, `DELETE /user`, `POST /auth/github/link` and `DELETE /auth/github/link` together 10 per account, and each of the two groups 100 per client IP. An IPv6 client counts as its /48 for the 10 per address and IP, and as its /56 for the 100 per client IP. Failures from other IPs only lock the owner out once they reach the 100 per address, and not on a device that logged in before: a successful `POST /auth/login` sets an `HttpOnly` `VB-DEVICE` cookie for `/auth/login`, valid for 30 days and signed for that account, its password and e-mail address, and a login sending it for the same address counts against that cookie's own 100 per address instead of the shared one (the 10 per address and IP and the 100 per client IP still apply). It stops working when the account's address or password changes (including a password reset) or the account is deleted, until the next login. Only `403` and `404` answers count, so successful requests, `400`s and `409`s don't. Over a limit the endpoint answers `429` with a JSON `error` and `retryAfter` (seconds), plus a `Retry-After` header that is exposed to the CORS origins, even for the right password, until the window ends. The counters live in memory and reset when the API restarts. The client IP is the last `X-Forwarded-For` address added by a loopback or private-network proxy (cloudflared, the cdn's nginx), so a client can't pick its own.
- E-mailed codes are limited too: one per address per minute, 10 sent per client IP per hour, at most `MAIL_DAILY_LIMIT` (default 250) e-mails a day in total, of which a fifth is kept for mail to existing accounts (registration and its resend answer `503` once the day's count of all mail reaches the other four fifths), and wrong codes count like failed password checks (10 per address, or per account for `POST /user/email/confirm`, and 100 per IP per 15 minutes), plus at most 20 wrong codes a day for an account's password reset or e-mail change and for a waiting registration, stored beside the code so resends and restarts don't reset it (a capped password reset answers like a wrong code). Only a checked and rejected code counts. `POST /auth/password-reset` keeps mailing codes to an address over the wrong-code limits, and the link in its mail isn't gated by them: `POST /auth/password-reset/confirm-link` only allows 100 rejected tokens per client IP (an IPv6 client counts as its /56) per 15 minutes. See [email-setup](./docs/email-setup.md#limits).
- `GET /auth/username-available` allows 30 checks per client IP per minute, whatever they answer, since it can list usernames. Over it: `429` with a JSON `error` and `retryAfter` (seconds), plus a `Retry-After` header.

### Short links

- `POST /shortenUrl` with `{"url"}` shortens a URL for the logged-in user (`201`), or answers `200` with the user's existing short link for it.
- `GET /shortenUrl/:shortenedUrl` returns the original URL and who added it, and `GET /r/:shortenedUrl` redirects to it.
- `DELETE /shortenUrl/:shortenedUrl` deletes a short link: only its owner or the superuser may (else `403`), and an unknown code answers `404`.
- `POST /shortenUrl/create` and `DELETE /shortenUrl/delete` (with `{"shortenedUrl"}` in the body) are deprecated and still work the same way: they will be removed after the next release.

### Admin endpoints

The superuser (`SUPERUSER_EMAIL`) can list users, set their upload quotas, list their uploads and check today's mail budget. See [admin-endpoints](./docs/admin-endpoints.md).

### Unknown routes

A route that doesn't exist answers `404` with a JSON `error`. Only a browser navigation (a request that prefers `text/html` over JSON) is redirected with `302` to the site's `/apierror?url=<path>` page instead.

## Setting up the application

### General setup

**A MongoDB database is required for running the application:**

- [OFFICIAL DOCUMENTATION](https://www.mongodb.com/docs/manual/installation/)
- [MongoDB on a Debian Linux server](./docs/db/mongodb-deb13-setup.md)
- (Was an edge case for me in the past) [MongoDB 4.4 on Raspberry Pi 4 with Debian 13](./docs/db/mongodb-pi4-deb13-setup.md)

1. Clone the repository.
2. Based on the use-case, follow either the [Dev Setup](./docs/dev-setup.md) guide or the [Docker](#docker) section below.

The old systemd-based production setup is kept in [archive/](./archive/README.md) for reference only.

## Docker

The API ships as a compose stack with two services: `api` (the built app, `ghcr.io/vb2007/vb2007.hu-api`) and `cloudflared` (a Cloudflare Tunnel, since the server has a dynamic public IP). The API is also published on `127.0.0.1:3000`, only on the host's loopback, for the cdn's nginx.

MongoDB isn't part of the stack: `DB_CONNECTION_STRING` points at the existing database. The `/healthz` endpoint answers `200` while the database is connected and `503` otherwise; the container healthcheck uses it.

### Running the stack by hand (Debian)

The server is normally deployed automatically (see [Releases & deployment](#releases--deployment)); this is the manual route, e.g. for a second machine or local testing.

1. Install Docker Engine and the Compose plugin from [Docker's apt repository](https://docs.docker.com/engine/install/debian/).
2. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels**, create a tunnel (type *Cloudflared*) and copy its token (the long string after `--token` in the install command).
3. On that tunnel add a **public hostname** (e.g. `api.vb2007.hu`) with service type `HTTP` and URL `api:3000`.
4. Configure the stack:

   ```sh
   git clone https://github.com/vb2007/vb2007.hu-api.git && cd vb2007.hu-api
   cp .env.example .env
   # edit .env, see docs/dotenv-setup.md (TUNNEL_TOKEN and UPLOADS_DIR are the Docker-only ones)
   mkdir -p uploads
   ```

   `.env.example` holds the dev database's URL: set `DB_CONNECTION_STRING` to the production one (see [mongodb-deb13-setup](./docs/db/mongodb-deb13-setup.md#7-creating-a-connection-string)). The container runs as uid `1000`, so the uploads folder (`UPLOADS_DIR`, `./uploads` by default) must be writable by it. `APP_IP`, `APP_PORT` and `UPLOAD_DISK_DIRECTORY` are set by `compose.yaml`.

5. Start it:

   ```sh
   docker compose up -d --build
   ```

### Day to day

```sh
docker compose ps                  # api should be "healthy"
docker compose logs -f cloudflared # look for "Registered tunnel connection"
git pull && docker compose up -d --build   # deploy an update
docker compose down                # stop and remove the containers
```

Compose refuses to start if `TUNNEL_TOKEN` is missing. `.env` is gitignored: keep the secrets out of version control.

## Releases & deployment

`.github/workflows/release.yml` runs on every push to `main` (a merged PR) on the self-hosted runners labelled `host`, which live on the production host. It can also be started from the Actions tab, but only on `main`: nothing is built, released or deployed from `dev` or any other branch.

| Job | What it does |
|---|---|
| Determine version | `.github/scripts/next-version.mjs` picks the version (see below) |
| Build & push image | Builds the Docker image and pushes `ghcr.io/vb2007/vb2007.hu-api` as `<version>`, `sha-<commit>` and `latest` |
| Cut release | New versions only: tags `v<version>` and publishes a GitHub release |
| Deploy | Pulls the `sha-<commit>` image, runs pending [migrations](#migrations) and restarts the stack on the host, then smoke-tests the public API |

Deploys run one at a time, and only after the release exists. A failing job stops the pipeline before anything is replaced.

### Versions

- By default every merge to `main` bumps the **patch** of the latest `v*` tag (`v1.4.0` → `v1.4.1`).
- For a **minor or major** release, raise `version` in `package.json` in the PR. A version newer than the latest tag is released as is.
- Re-running the workflow on a commit that is already tagged makes no new release; it just redeploys.

Each release has auto-generated notes, the image digest, the test summary of the merged PR's unit test run (when it can be found), and these assets: a `compose.yaml` pinned to that version, `images.json`, `api-dist-<version>.tar.gz` (the built app, taken from the pushed image) and the HTML/ODS test reports.

### Self-hosted runners

| Label | Where | Runs |
|---|---|---|
| `host` | Production host | Only `release.yml` and `dev-to-main-pr.yml` |
| `ci` | Separate CI server | PR checks: `unit-tests.yml` and `docker-build.yml` |

PR workflows run untrusted code, so they must never use `host`: pin every new one to `[self-hosted, ci]`.

Every runner is a systemd service (`sudo ./svc.sh install`). To restart them when they crash, add a drop-in that covers every `actions.runner.vb2007-*` unit, then run `sudo systemctl daemon-reload`:

```ini
# /etc/systemd/system/actions.runner.vb2007-.service.d/restart.conf
[Service]
Restart=on-failure
RestartSec=30
```

The `ci` runner user needs Docker access, `ss`, `curl` and `openssl`, and has to reach the database in the `CI_DB_CONNECTION_STRING` secret (see [mongodb-deb13-setup](./docs/db/mongodb-deb13-setup.md#9-ci-database--user)).

### One-time host setup

The `host` runner needs Docker access, `curl`, `gh` and the deploy directory, `/home/vb2007/prod/vb2007.hu-api`, holding the `.env` file (see [dotenv-setup](./docs/dotenv-setup.md), including `TUNNEL_TOKEN`). The workflow copies `compose.yaml` there on every deploy and never touches `.env`.

1. Stop the old systemd service, so port `3000` is free: `sudo systemctl disable --now vb2007hu-api.service`
2. Create the tunnel and its public hostname (`api.vb2007.hu` → `http://api:3000`, see [Docker](#docker)), and add `TUNNEL_TOKEN` to `.env`.
3. Point `UPLOADS_DIR` in `.env` at the uploads folder (`/mnt/raid1/cdn/useruploads`) and make it writable by uid `1000`.
4. Set up the cdn's nginx, which serves the uploads, see [cdn-setup](./docs/cdn-setup.md).
5. Optionally enable GitHub login: create the OAuth App and add the `GITHUB_*` variables to `.env`, see [github-oauth-setup](./docs/github-oauth-setup.md).

Optional repository variable (Settings → Secrets and variables → Actions → Variables):

| Variable | Used for | Default |
|---|---|---|
| `API_URL` | Public URL the deploy smoke-tests (`<API_URL>/healthz`); skipped when unset | none |

To roll back, re-run the workflow on an older commit's run, or on the host run `IMAGE_TAG=<version> docker compose up -d --no-build` in `/home/vb2007/prod/vb2007.hu-api`.

### Migrations

The deploy runs pending database migrations with the new image before restarting the stack. If one fails, the deploy stops and the previous version keeps running. See [migrations](./docs/migrations.md) for adding one and running them by hand.

## CI

| Workflow | Runs on | What it checks |
|---|---|---|
| `unit-tests.yml` | PRs into `main` or `dev`, on the `ci` runners | Jest + supertest against a running API; publishes HTML/ODS/Markdown reports via `.github/scripts/junit-report.mjs`. Each job gets its own port and test data, so jobs run in parallel |
| `docker-build.yml` | PRs into `main` or `dev`, on the `ci` runners | Builds the Docker image (never pushed) |

## Opening the dev → main PR

`.github/workflows/dev-to-main-pr.yml` is started by hand from the Actions tab ("Run workflow"). It opens a PR from `dev` to `main` titled `Merge dev To main`, assigned to the owner, whose description lists every PR merged into `dev` that `main` doesn't have yet, stacked PRs included, with the issues each one closes (`.github/scripts/dev-to-main-body.mjs` reads them from GitHub's linked issues, so both `Resolves: #<issue>` lines and issues linked in the sidebar count). Merging that PR closes those issues. If `package.json`'s version on `dev` still equals `main`'s, it comments on the PR and warns that merging releases a patch version (`.github/scripts/version-bump-warning.mjs`), so bump it on `dev` first for a minor or major release. It does nothing if there's nothing new. While the PR is open, every push to `dev` (and a manual run) rewrites its description, so PRs merged after it was opened show up too; a push never opens the PR. Each refresh also checks the version again: the warning comment is updated rather than repeated, and deleted once the version is bumped on `dev`, whether by a PR or a direct push.

The workflow only shows up in the Actions tab once it is on `main`. A PR opened with the default `GITHUB_TOKEN` doesn't trigger the PR checks; to get them, add a `PR_TOKEN` secret (a fine-grained PAT for this repo with Pull requests: read/write and Contents: read), which the workflow prefers. Without `PR_TOKEN`, the repo setting "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General) must be on. If neither is in place, the run fails with "GitHub Actions is not permitted to create or approve pull requests" and an error naming both fixes.
