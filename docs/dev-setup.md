# Running the application for development

## Config variables in .env

Refer to [dotenv-setup](./dotenv-setup.md).

Point `DB_CONNECTION_STRING` at the `vb2007hu-dev` database (URL shape in [dotenv-setup](./dotenv-setup.md#required-variables)), never at production, which only the deploy uses. Ask the owner for the dev database's host and password; [mongodb-deb13-setup](./db/mongodb-deb13-setup.md#8-dev-database--user) shows how it's created.

## Installing dependencies and modifying the code

After setting up the `.env` file, install the application's dependencies:

```shell
yarn install --frozen-lockfile
```

Start the application with:

```shell
yarn start
```

## Running the unit tests

The tests run against a running API that uses the same `.env`, so set `SUPERUSER_EMAIL` to a test address (e.g. `superuser@local.vb2007.test`, see [dotenv-setup](./dotenv-setup.md#unit-test-variables)) and restart the API after changing it. Then, with the API running:

```shell
yarn test
```

- Start the API with `UV_THREADPOOL_SIZE=8`, like the image and CI do (e.g. `yarn build && UV_THREADPOOL_SIZE=8 node dist/index.js`), so password hashing gets 6 threads instead of 2.

- Every run creates its own users with e-mails at or under `<TEST_RUN_ID>.vb2007.test`, plus its own superuser, and deletes them with everything they own (pastes, short URLs, uploads and their files) when it finishes. Test data older than a day, left by runs that were killed, is removed at the start of the next run: test users (by `createdAt`, or their `_id` timestamp when it's missing) and other runs' `migrations-test-*`, `users-test-*` and `shorturls-test-*` collections whose newest document is older than a day (empty ones are kept, as a running test empties them between tests).
- Test files run in parallel Jest workers, and several runs can share a database at once as long as each has its own API and `SUPERUSER_EMAIL` (CI gives every job its own port and run ID).
- When writing tests, create the users and data a test needs with the helpers in `src/tests/helpers/testUsers.ts` (`createTestUser()`) and use `TestData.superuser.cookie` for superuser requests. Never log in or out as the superuser, and don't give it content of its own.
- Failed logins and password checks count against a per-IP [rate limit](../README.md#account-rules) that every test from `localhost` shares for 15 minutes, or until the API restarts. A test that fails them on purpose more than once or twice sends its own `X-Forwarded-For` address (trusted from loopback), like `src/tests/rateLimit.test.ts`, so repeated runs against one API stay under the limit.
- Without the [`GITHUB_*` variables](./dotenv-setup.md#github-login-variables), the tests that need GitHub login configured are skipped and the others still run. Placeholder values like CI's (see `.github/workflows/unit-tests.yml`) are enough to run them, but the API has to run with the same values, so restart it after changing them (otherwise those tests fail, or skip silently).
