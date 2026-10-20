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
| `DB_CONNECTION_STRING` | MongoDB connection URL | `mongodb://localhost:27017/vb2007` |
| `CORS_ORIGIN_URLS` | Allowed frontend origins (comma separated) | `http://localhost:5173,https://api.example.com` |
| `CRYPTO_SECRET_KEY` | Secret key for crypto/token work | `verySecret_@nd_comp1ex_K€y` |
| `BASE_SITE_URL` | Main website URL | `https://vb2007.hu` |
| `CDN_URL` | CDN base URL | `https://cdn.vb2007.hu` |
| `UPLOAD_DISK_DIRECTORY` | Folder for uploaded files, should be an absolute path (a relative one resolves from the working directory) | `/tmp/uploads` |
| `UPLOAD_MAX_FILESIZE` | Upload size limit in MB, defaults to `100` if missing or not a positive integer | `10` |
| `TEST_EMAIL` | Test user email | `testuser@example.com` |
| `TEST_USERNAME` | Test user name | `testuser` |
| `TEST_PASSWORD` | Test user password | `testpasswd` |

## Docker-only variables

Only read by `compose.yaml` (see the [README](../README.md#docker)). Compose sets `APP_PORT` and `UPLOAD_DISK_DIRECTORY` inside the container itself.

| Variable | What it is | Example |
| --- | --- | --- |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token (Zero Trust > Networks > Tunnels) | `eyJhIjoi...` |
| `UPLOADS_DIR` | Host folder mounted as the upload directory, writable by uid `1000` | `./uploads` |
