# Config values in .env

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
| `UPLOAD_DISK_DIRECTORY` | Folder for uploaded files | `/tmp/uploads` |
| `UPLOAD_MAX_FILESIZE` | Upload size limit in MB | `10` |
| `TEST_EMAIL` | Test user email | `testuser@example.com` |
| `TEST_USERNAME` | Test user name | `testuser` |
| `TEST_PASSWORD` | Test user password | `testpasswd` |
