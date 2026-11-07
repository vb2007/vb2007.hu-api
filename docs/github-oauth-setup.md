# GitHub login (OAuth2)

Users can register and log in with GitHub. It's off until the three `GITHUB_*` variables are set in `.env`; until then `GET /auth/github` redirects with `oauthError=notConfigured`, and so does `GET /auth/github/link` for a logged-in account without a password (a logged-out user gets `notLoggedIn`), while `POST /auth/github/link` answers `503` with `{"error": "notConfigured"}`.

## Creating the OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL: the site (`https://vb2007.hu`).
3. Authorization callback URL: `<API URL>/auth/github/callback`, e.g. `https://api.vb2007.hu/auth/github/callback`. One app serves both production and local development: add `http://localhost:3000/auth/github/callback` as a second callback URL in the app's settings, and leave wildcard matching off. The `__Host-VB-OAUTH` cookie is always `Secure`, so over plain http GitHub login only works on `http://localhost` or `http://127.0.0.1` in browsers that treat those as secure (Chromium, Firefox), not over a LAN IP or another http hostname.
4. Generate a client secret for each environment (production and local development each get their own, so one can be revoked alone), then set them in `.env`:

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | The app's client ID |
| `GITHUB_CLIENT_SECRET` | This environment's client secret |
| `GITHUB_CALLBACK_URL` | This environment's callback URL from step 3, exactly as set on the app |

## Endpoints

These are browser navigations, not `fetch` calls: the frontend links to them (or, for `POST /auth/github/link` below, navigates to the URL it answers).

| Route | What it does |
| --- | --- |
| `GET /auth/github` | Logs in with GitHub, creating the account on first login (username from the GitHub login, e-mail from the primary verified GitHub e-mail, lower-cased, no password) |
| `GET /auth/github/link` | Relinks GitHub to the logged-in account when it has no password (made with GitHub); without a session it redirects with `oauthError=notLoggedIn`, and an account with a password gets `oauthError=passwordRequired` and starts with `POST /auth/github/link` instead. It never replaces a different linked GitHub account (`oauthError=githubOtherLinked`) |
| `GET /auth/github/callback` | GitHub redirects here. On login it sets the `__Host-VB-AUTH` cookie and redirects to `BASE_SITE_URL`; on link it sets a new `__Host-VB-AUTH` cookie (the old one stops working) and redirects to `<BASE_SITE_URL>/account?github=linked` |

`POST /auth/github/link` is a `fetch` call that starts linking GitHub to the logged-in account. An account with a password sends it as `{"password": "…"}`: a missing, empty or non-string password answers `400` and a wrong one `403`; an account without a password needs none. It sets the `__Host-VB-OAUTH` cookie like the `GET` routes (`Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`, so no other `*.vb2007.hu` host can plant it) and answers `200` with `{"url": "<GitHub authorize URL>"}`, which the frontend navigates to. Like `GET /auth/github/link`, it also stores a proof on the account, bound to the current session and the flow's state and PKCE verifier and valid for 10 minutes. The callback uses it up before exchanging the code, and without it (e.g. a hand-made `__Host-VB-OAUTH` cookie, or one started by another session) redirects with `oauthError=invalidState`, so neither a stolen `__Host-VB-AUTH` cookie nor a planted OAuth cookie can link another GitHub account. Starting a second link replaces the first one's proof, so the first then fails with `invalidState`. A link callback without a logged-in session redirects with `oauthError=notLoggedIn` before the code exchange.

A GitHub login never attaches itself to an existing password account with the same e-mail: those users log in with their password and use `POST /auth/github/link`. Accounts made with GitHub have no password, so `POST /auth/login` refuses them with the same `403` as a wrong password or an unknown address (see the [README](../README.md#account-rules)) until they set one with `POST /user/password`.

A linked user stores the GitHub login as `githubLogin`, refreshed on every GitHub login since it can be renamed on GitHub. `GET /user` returns `githubLogin` and `hasPassword`, so the frontend can show `@login` and knows when an account has no password.

`DELETE /auth/github/link` is a `fetch` call that unlinks GitHub from the logged-in account, confirmed with its password as `{"password": "…"}`. It answers `404` when no GitHub account is linked, `403` when the account has no password, since GitHub is then its only way to log in (set one first with `POST /user/password`), `400` when the password is missing, empty or isn't a string, and `403` when it's wrong.

`POST /user/password` with `{"password": "…"}` sets a password on the logged-in account when it has none (`hasPassword` is `false`), so it can log in with `POST /auth/login` and unlink GitHub. The password follows the same rules as `POST /auth/register`: a string of 8 to 128 characters, else `400` (see the [README](../README.md#account-rules)). It answers `409` when the account already has a password, since it doesn't change an existing one: `PATCH /user/password` does that.

Since a GitHub-only account has no password to re-enter, `POST /user/password` first needs GitHub to confirm it's the owner: a GitHub login (`GET /auth/github`) or link (`GET /auth/github/link`) within the last 10 minutes. Otherwise it answers `403` (an account that already has a password still gets `409`), and the frontend sends the user through `/auth/github/link`, which relinks the same GitHub account, then retries. A relink, like a GitHub login, starts a new session: the old `__Host-VB-AUTH` cookie stops working, so only the session the confirmation started can set the password, and only once. Setting it starts another new session and sets a fresh `__Host-VB-AUTH` cookie. An e-mail notification about the new password waits on e-mail sending (#28).

`DELETE /user` on a GitHub-only account takes `{"username": "<own username>"}` as a typo guard, and also needs a GitHub login or relink within the last 10 minutes from the same session, since the username alone is readable by anyone holding the cookie. Otherwise it answers `403` and deletes nothing, so the frontend sends the user through `/auth/github/link` and retries. The confirmation is read from the request's own session, and the account is only deleted if that session, the missing password and the confirmation still hold at that moment. If the session ends or a password is set while the deletion runs, it answers `403` and keeps the account, though its content may already be gone. Accounts with a password confirm with it as before.

`PATCH /user/password` answers `409` for an account without a password: it has to set one first with `POST /user/password`.

`PATCH /user/email` is a `fetch` call that starts changing the logged-in account's e-mail, e.g. away from the GitHub e-mail it was created with. It takes `{ "email", "password" }`, trims and lower-cases the address, and mails a code to it (`202`); the account keeps its current address until `POST /user/email/confirm` with `{ "code" }` confirms the new one (see [email-setup](./email-setup.md#e-mail-change)). The password confirms it's the owner, so an account without one gets `409` until it sets one with `POST /user/password`. It answers `400` for a missing field, a malformed address or a disposable or undeliverable domain, `403` for a wrong password, and `403` when the superuser changes away from `SUPERUSER_EMAIL` (it changes `.env` instead). Another account's address, whatever its case, and `SUPERUSER_EMAIL` get the same `202` and code as any other address, so the endpoint doesn't reveal which addresses have accounts: `POST /user/email/confirm` answers `409` for another account's address and `403` for `SUPERUSER_EMAIL`, and drops the change. Sending the current address again answers `200` and changes nothing. GitHub logins match on `githubId`, so a linked GitHub account keeps working.

## Errors

On failure the login flow redirects to `<BASE_SITE_URL>/login?oauthError=<code>` and the link flow to `<BASE_SITE_URL>/account?oauthError=<code>`. Errors raised before the flow is known (no or an invalid OAuth cookie) go to `/login`.

| Code | Meaning |
| --- | --- |
| `notConfigured` | The `GITHUB_*` variables aren't set on the server |
| `accessDenied` | The user cancelled on GitHub |
| `invalidState` | The state didn't match (expired after 10 minutes, or a forged request), a link for an account with a password wasn't started with its password through `POST /auth/github/link` in the same session, or a login's GitHub account was unlinked from the account (or the account suspended) while the login ran, which then gets no session and changes nothing |
| `githubError` | GitHub rejected the code, its API failed, or the server failed |
| `noVerifiedEmail` | The GitHub account has no primary verified e-mail |
| `emailExists` | A password account already uses that e-mail, whatever its case: log in and link instead |
| `githubAlreadyLinked` | That GitHub account is linked to another user |
| `githubOtherLinked` | The account already has a different GitHub account linked: unlink it first with `DELETE /auth/github/link` |
| `notLoggedIn` | Linking was started or finished without a logged-in session |
| `passwordRequired` | `GET /auth/github/link` was used by an account with a password: start with `POST /auth/github/link` and the password instead |
| `accountSuspended` | The GitHub account belongs to a suspended account, which gets no session (see [admin-endpoints](./admin-endpoints.md#patch-adminusersidsuspension)) |
