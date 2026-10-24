# GitHub login (OAuth2)

Users can register and log in with GitHub. It's off until the three `GITHUB_*` variables are set in `.env`; until then `GET /auth/github` and `/auth/github/link` redirect with `oauthError=notConfigured`.

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
| `GET /auth/github/link` | Links GitHub to the logged-in account |
| `GET /auth/github/callback` | GitHub redirects here. On login it sets the `VB-AUTH` cookie and redirects to `BASE_SITE_URL`; on link it redirects to `<BASE_SITE_URL>/account?github=linked` |

A GitHub login never attaches itself to an existing password account with the same e-mail: those users log in with their password and use `/auth/github/link`. Accounts made with GitHub have no password, so `POST /auth/login` refuses them.

A linked user stores the GitHub login as `githubLogin`, refreshed on every GitHub login since it can be renamed on GitHub. `GET /user` returns `githubLogin` and `hasPassword`, so the frontend can show `@login` and knows when an account has no password.

`DELETE /auth/github/link` is a `fetch` call that unlinks GitHub from the logged-in account. It answers `404` when no GitHub account is linked, and `403` when the account has no password, since GitHub is then its only way to log in.

## Errors

On failure the login flow redirects to `<BASE_SITE_URL>/login?oauthError=<code>` and the link flow to `<BASE_SITE_URL>/account?oauthError=<code>`. Errors raised before the flow is known (no or an invalid OAuth cookie) go to `/login`.

| Code | Meaning |
| --- | --- |
| `notConfigured` | The `GITHUB_*` variables aren't set on the server |
| `accessDenied` | The user cancelled on GitHub |
| `invalidState` | The state didn't match (expired after 10 minutes, or a forged request) |
| `githubError` | GitHub rejected the code or its API failed |
| `noVerifiedEmail` | The GitHub account has no primary verified e-mail |
| `emailExists` | A password account already uses that e-mail, whatever its case: log in and link instead |
| `githubAlreadyLinked` | That GitHub account is linked to another user |
| `notLoggedIn` | Linking finished without a logged-in session |
