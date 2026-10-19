# Archive

> [!WARNING]
> Nothing in this folder is used anymore. It's kept for reference only.

The pre-Docker deployment, last used for v1.3.3: the API ran from a git checkout as a systemd service behind a host nginx reverse proxy. It was replaced by the Docker image, `compose.yaml` and `.github/workflows/release.yml` (see the [README](../README.md#releases--deployment)).

| Path | What it was |
| --- | --- |
| [workflows/build-deploy.yml](./workflows/build-deploy.yml) | Pulled, built and restarted the systemd service on push to `main` |
| [workflows/gh-release.yml](./workflows/gh-release.yml) | Cut a GitHub release when `package.json` had a new version |
| [production/vb2007hu-api.service](./production/vb2007hu-api.service) | The systemd unit |
| [production/vb2007-api.conf](./production/vb2007-api.conf) | The host nginx reverse proxy for `api.vb2007.hu` |
| [docs/prod-setup.md](./docs/prod-setup.md) | The manual production setup guide |
