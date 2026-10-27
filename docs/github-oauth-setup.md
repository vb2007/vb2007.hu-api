# GitHub login (OAuth2)

Users can register and log in with GitHub. It's off until the three `GITHUB_*` variables are set in `.env`; until then `GET /auth/github` redirects with `oauthError=notConfigured`, and so does `/auth/github/link` for a logged-in user (a logged-out user gets `notLoggedIn`).

## Creating the OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL: the site (`https://vb2007.hu`).
3. Authorization callback URL: `<API URL>/auth/github/callback`, e.g. `https://api.vb2007.hu/auth/github/callback`. One app serves both production and local development: add `http://localhost:3000/auth/github/callback` as a second callback URL in the app's settings, and leave wildcard matching off.
4. Generate a client secret for each environment (production and local development each get their own, so one can be revoked alone), then set them in `.env`:

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | The app's client ID |
| `GITHUB_CLIENT_SECRET` | This environment's client secret |
| `GITHUB_CALLBACK_URL` | This environment's callback URL from step 3, exactly as set on the app |

## Endpoints

These are browser navigations, not `fetch` calls: the frontend links to them.

| Route | What it does |
| --- | --- |
| `GET /auth/github` | Logs in with GitHub, creating the account on first login (username from the GitHub login, e-mail from the primary verified GitHub e-mail, lower-cased, no password) |
| `GET /auth/github/link` | Links GitHub to the logged-in account; without a session it redirects with `oauthError=notLoggedIn`. It never replaces a different linked GitHub account (`oauthError=githubOtherLinked`) |
| `GET /auth/github/callback` | GitHub redirects here. On login it sets the `VB-AUTH` cookie and redirects to `BASE_SITE_URL`; on link it sets a new `VB-AUTH` cookie (the old one stops working) and redirects to `<BASE_SITE_URL>/account?github=linked` |

A GitHub login never attaches itself to an existing password account with the same e-mail: those users log in with their password and use `/auth/github/link`. Accounts made with GitHub have no password, so `POST /auth/login` refuses them until they set one with `POST /user/password`.

A linked user stores the GitHub login as `githubLogin`, refreshed on every GitHub login since it can be renamed on GitHub. `GET /user` returns `githubLogin` and `hasPassword`, so the frontend can show `@login` and knows when an account has no password.

`DELETE /auth/github/link` is a `fetch` call that unlinks GitHub from the logged-in account. It answers `404` when no GitHub account is linked, and `403` when the account has no password, since GitHub is then its only way to log in; set one first with `POST /user/password`.

`POST /user/password` with `{"password": "…"}` sets a password on the logged-in account when it has none (`hasPassword` is `false`), so it can log in with `POST /auth/login` and unlink GitHub. The password follows the same rules as `POST /auth/register`: a string of 8 to 128 characters, else `400` (see the [README](../README.md#account-rules)). It answers `409` when the account already has a password, since it doesn't change an existing one: `PATCH /user/password` does that.

Since a GitHub-only account has no password to re-enter, `POST /user/password` first needs GitHub to confirm it's the owner: a GitHub login (`GET /auth/github`) or link (`GET /auth/github/link`) within the last 10 minutes. Otherwise it answers `403` (an account that already has a password still gets `409`), and the frontend sends the user through `/auth/github/link`, which relinks the same GitHub account, then retries. A relink, like a GitHub login, starts a new session: the old `VB-AUTH` cookie stops working, so only the session the confirmation started can set the password, and only once. Setting it starts another new session and sets a fresh `VB-AUTH` cookie. An e-mail notification about the new password waits on e-mail sending (#28).

`PATCH /user/password` answers `409` for an account without a password: it has to set one first with `POST /user/password`.

`PATCH /user/email` is a `fetch` call that changes the logged-in account's e-mail, e.g. away from the GitHub e-mail it was created with. It takes `{ "email", "password" }` and stores the address trimmed and lower-cased. The password confirms it's the owner, so an account without one gets `409` until it sets one with `POST /user/password`. It answers `400` for a missing field or a malformed address, `403` for a wrong password, `409` when another account uses the address whatever its case, and `403` when changing to or away from `SUPERUSER_EMAIL` (the superuser changes `.env` instead). Sending the current address again answers `200` and changes nothing. GitHub logins match on `githubId`, so a linked GitHub account keeps working.

## Errors

On failure the login flow redirects to `<BASE_SITE_URL>/login?oauthError=<code>` and the link flow to `<BASE_SITE_URL>/account?oauthError=<code>`. Errors raised before the flow is known (no or an invalid OAuth cookie) go to `/login`.

| Code | Meaning |
| --- | --- |
| `notConfigured` | The `GITHUB_*` variables aren't set on the server |
| `accessDenied` | The user cancelled on GitHub |
| `invalidState` | The state didn't match (expired after 10 minutes, or a forged request) |
| `githubError` | GitHub rejected the code, its API failed, or the server failed |
| `noVerifiedEmail` | The GitHub account has no primary verified e-mail |
| `emailExists` | A password account already uses that e-mail, whatever its case: log in and link instead |
| `githubAlreadyLinked` | That GitHub account is linked to another user |
| `githubOtherLinked` | The account already has a different GitHub account linked: unlink it first with `DELETE /auth/github/link` |
| `notLoggedIn` | Linking was started or finished without a logged-in session |
