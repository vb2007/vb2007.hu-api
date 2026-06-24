# vb2007.hu-api

<div align="center">

[![Build and Deploy](https://github.com/vb2007/vb2007.hu-api/actions/workflows/build-deploy.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/build-deploy.yml) [![Release on GitHub](https://github.com/vb2007/vb2007.hu-api/actions/workflows/gh-release.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/gh-release.yml)

[![API Unit Tests](https://github.com/vb2007/vb2007.hu-api/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/unit-tests.yml) [![CodeQL](https://github.com/vb2007/vb2007.hu-api/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/vb2007/vb2007.hu-api/actions/workflows/github-code-scanning/codeql)

</div>

## About

A simple API for my personal website, written with Express.js and some other packages.

This project was made for replacing the first version of my site written in PHP: [vb2007.hu-php](https://github.com/vb2007/vb2007.hu-php)

The API is mainly - but not only - used on the project's frontend: [vb2007.hu-vue](https://github.com/vb2007/vb2007.hu-vue)

## Setting up the application

### General setup

**A MongoDB database is required for running the application:**

- [OFFICIAL DOCUMENTATION](https://www.mongodb.com/docs/manual/installation/)
- [MongoDB on a Debian Linux server](./docs/db/mongodb-deb13-setup.md)
- (Was an edge case for me in the past) [MongoDB 4.4 on Raspberry Pi 4 with Debian 13](./docs/db/mongodb-pi4-deb13-setup.md)

1. Clone the repository.
2. Based on the use-case, follow either the [Dev Setup](./docs/dev-setup.md) or [Prod Setup](./docs/prod-setup.md) guide.
