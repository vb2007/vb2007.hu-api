# vb2007.hu-api

<div align="center">

[![Release & Deploy](https://github.com/vb2007/vb2007.hu-api/actions/workflows/release.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/release.yml) [![Docker Build](https://github.com/vb2007/vb2007.hu-api/actions/workflows/docker-build.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/docker-build.yml)

[![API Unit Tests](https://github.com/vb2007/vb2007.hu-api/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/unit-tests.yml) [![CodeQL](https://github.com/vb2007/vb2007.hu-api/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/github-code-scanning/codeql)

</div>

## About

A simple API for my personal website, written with Express.js and some other packages.

This project was made for replacing the first version of my site written in PHP: [vb2007.hu-php](https://github.com/vb2007/vb2007.hu-php)

The API is mainly - but not only - used on the project's frontend: [vb2007.hu-vue](https://github.com/vb2007/vb2007.hu-vue)

### Account rules

- Usernames are 2 to 16 characters.
- Passwords are 8 to 128 characters, checked whenever a password is set, by `POST /auth/register`, `POST /user/password` and `PATCH /user/password` (`passwordLengthError` in `src/helpers/index.ts`); anything else answers `400`. Accounts with a shorter password from before these rules can still log in.
- `PATCH /user/password` with `{"currentPassword": "…", "newPassword": "…"}` changes the logged-in user's password. It answers `400` when a field is missing, isn't a string or the new password breaks the rules, `403` when the current password is wrong and `409` when the account has no password (made with GitHub): set one with `POST /user/password` first. On success it starts a new session: the old `VB-AUTH` cookie stops working and the response sets a fresh one. A linked GitHub account stays linked.

### Admin endpoints

The superuser (`SUPERUSER_EMAIL`) can list users, set their upload quotas and list their uploads, see [admin-endpoints](./docs/admin-endpoints.md).

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

   The container runs as uid `1000`, so the uploads folder (`UPLOADS_DIR`, `./uploads` by default) must be writable by it. `APP_PORT` and `UPLOAD_DISK_DIRECTORY` are set by `compose.yaml`.

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

`.github/workflows/release.yml` runs on every push to `main` (a merged PR) on the self-hosted runner, which lives on the production host. It can also be started from the Actions tab, but only on `main`: nothing is built, released or deployed from `dev` or any other branch.

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

### One-time host setup

The runner needs Docker access and the deploy directory, `/home/vb2007/prod/vb2007.hu-api`, holding the `.env` file (see [dotenv-setup](./docs/dotenv-setup.md), including `TUNNEL_TOKEN`). The workflow copies `compose.yaml` there on every deploy and never touches `.env`.

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
| `unit-tests.yml` | PRs into `main` or `dev` | Jest + supertest against a running API; publishes HTML/ODS/Markdown reports via `.github/scripts/junit-report.mjs`. Each job gets its own port and test data, so jobs run in parallel |
| `docker-build.yml` | PRs into `main` or `dev` | Builds the Docker image (never pushed) |

## Opening the dev → main PR

`.github/workflows/dev-to-main-pr.yml` is started by hand from the Actions tab ("Run workflow"). It opens a PR from `dev` to `main` titled `Merge dev To main`, assigned to the owner, whose description lists every PR merged into `dev` that `main` doesn't have yet, stacked PRs included, with the issues each one closes (`.github/scripts/dev-to-main-body.mjs` reads them from GitHub's linked issues, so both `Resolves: #<issue>` lines and issues linked in the sidebar count). Merging that PR closes those issues. If `package.json`'s version on `dev` still equals `main`'s, it comments on the PR and warns that merging releases a patch version (`.github/scripts/version-bump-warning.mjs`), so bump it on `dev` first for a minor or major release. It does nothing if there's nothing new. While the PR is open, every push to `dev` (and a manual run) rewrites its description, so PRs merged after it was opened show up too; a push never opens the PR. Each refresh also checks the version again: the warning comment is updated rather than repeated, and deleted once the version is bumped on `dev`, whether by a PR or a direct push.

The workflow only shows up in the Actions tab once it is on `main`. A PR opened with the default `GITHUB_TOKEN` doesn't trigger the PR checks; to get them, add a `PR_TOKEN` secret (a fine-grained PAT for this repo with Pull requests: read/write and Contents: read), which the workflow prefers. Without `PR_TOKEN`, the repo setting "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General) must be on. If neither is in place, the run fails with "GitHub Actions is not permitted to create or approve pull requests" and an error naming both fixes.
