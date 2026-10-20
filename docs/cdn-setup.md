# Setting up the cdn's nginx

`cdn.vb2007.hu` is a plain nginx on the host, serving `/mnt/raid1/cdn` behind Cloudflare. [production/cdn.conf](../production/cdn.conf) is its config. User uploads live under `/useruploads/<userId>/<uploadId>.<ext>`, and nginx asks the API (`GET /uploads/access` on `127.0.0.1:3000`) on every request whether the file may be served. Denied and missing files both answer `404`.

> [!IMPORTANT]
> Deploy this config only once an API release with `GET /uploads/access` is live, otherwise every `/useruploads/` request fails.

## Uploads folder

The API writes uploads to the cdn's folder, so in the deploy directory's `.env` (see the [README](../README.md#one-time-host-setup)):

```sh
UPLOADS_DIR=/mnt/raid1/cdn/useruploads
```

The container runs as the `node` user (uid `1000`), which needs write access:

```sh
sudo mkdir -p /mnt/raid1/cdn/useruploads
sudo chown -R 1000:1000 /mnt/raid1/cdn/useruploads
```

## Installing the config

The file starts with a `map`, which nginx only accepts in the `http` context. Files in `conf.d` are included there, so make sure `/etc/nginx/nginx.conf` has this line inside its `http { }` block:

```conf
include /etc/nginx/conf.d/*.conf;
```

Copy the file over the existing cdn config (replace it, don't add a second `server` for `cdn.vb2007.hu`), then test and reload:

```sh
sudo cp production/cdn.conf /etc/nginx/conf.d/cdn.conf
sudo nginx -t
sudo systemctl reload nginx
```

## Cloudflare

Cloudflare caches by file extension, so private files could end up in its edge cache. In the dashboard, under **Caching → Cache Rules**, add a rule for the `vb2007.hu` zone:

- **When:** hostname equals `cdn.vb2007.hu` and URI path starts with `/useruploads/`
- **Then:** cache eligibility **Bypass cache**

## Checking it

```sh
curl -I https://cdn.vb2007.hu/useruploads/<userId>/<publicUploadId>.<ext>   # 200, Cache-Control: public, max-age=300
curl -I https://cdn.vb2007.hu/useruploads/<userId>/<privateUploadId>.<ext>  # 404
curl -I -b "VB-AUTH=<owner's token>" https://cdn.vb2007.hu/useruploads/<userId>/<privateUploadId>.<ext>  # 200, Cache-Control: private, no-store
```

Successful responses also carry `X-Content-Type-Options: nosniff` and `Content-Disposition`.
