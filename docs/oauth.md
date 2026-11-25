# OAuth clients

First-party apps (the first one is spotdl-web) sign their users in through vb2007.hu and talk to the API server-to-server as registered clients. This page covers registering a client, the sign-in flow, authenticating as one and the routes clients can call.

## Client registry

The clients live in the `OAUTH_CLIENTS` variable of `.env`: one line holding a JSON array, wrapped in single quotes so neither dotenv nor `docker compose` (`env_file: .env`) changes it (without them, dotenv cuts the value at a `#` and compose expands `$`). Without it there are no clients. Each client is:

| Field | What it is |
| --- | --- |
| `id` | The public client id: 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit. Unique, and not an [API key scope](./api-keys.md#scopes)'s prefix (`account`, `pastes`, `shorturls`, `uploads`, `admin`) |
| `name` | Display name, not blank |
| `secretHash` | The client secret's SHA-256, as 64 lowercase hex digits. The secret itself is only given to the app |
| `redirectUris` | URLs the client may be sent back to, matched exactly: `https:`, or `http:` only on `localhost`, `127.0.0.1` or `[::1]`, without a fragment (RFC 6749 §3.1.2). May be empty |
| `scopes` | The client's own scope names, distinct, 1 to 64 lowercase letters, digits or hyphens each, starting with a letter or digit. May be empty. Each becomes the app scope `<id>:<scope>` that users can give their API keys (see [App scopes](#app-scopes)) |
| `accountStatus` | Optional, `false` when left out: `true` lets the client call [`POST /oauth/accounts/status`](#post-oauthaccountsstatus), which can look up any account. Give it only to clients whose secret lives on a production server (spotdl, not its dev client), so a leaked dev secret can't enumerate accounts |

Any other field (a plaintext `secret`, say) stops the API too.

```dotenv
OAUTH_CLIENTS='[{"id":"spotdl","name":"spotdl-web","secretHash":"<sha256 hex>","redirectUris":["https://spotdl.vb2007.hu/login/callback"],"scopes":["submit"]}]'
```

The API checks the list when it starts (`src/helpers/oauthClients.ts`) and refuses to start when it isn't valid JSON or an entry breaks a rule above, naming the entry. Changing it takes a restart.

To make a client's secret and its hash, run this, give the app the secret and put the hash in `secretHash`. Always make secrets this way: the client's protection against guessing rests on their 256 random bits (see [Limits](#limits)).

```bash
secret=$(openssl rand -hex 32); echo "secret: $secret"; echo "secretHash: $(printf %s "$secret" | sha256sum | cut -d' ' -f1)"
```

Keep the secret to hex (or other characters that need no URL encoding): the API reads the Basic credentials as they are, without the form decoding RFC 6749 asks clients to apply.

## Sign in with vb2007.hu

Apps sign users in with the OAuth 2.0 authorization code flow (RFC 6749) and PKCE (RFC 7636, `S256` only). The login itself runs on vb2007.hu's own pages, so every login method works (password + MFA, passkeys, GitHub, the mailed MFA link), the user's vb2007.hu session is never replaced, and the app gets the identity server-to-server. The handlers are in `src/controllers/oauthAuthorize.ts`.

1. **The app starts a sign-in.** It makes a random `state`, a random `nonce` and a PKCE pair: a `code_verifier` of 43 to 128 characters from `A-Z a-z 0-9 - . _ ~` (32 random bytes as base64url give 43), and its `code_challenge`, the unpadded base64url SHA-256 of the verifier (always 43 characters). It keeps all three (e.g. in its own session) and sends the browser to:

    ```
    https://api.vb2007.hu/oauth/authorize?response_type=code&client_id=spotdl&redirect_uri=https%3A%2F%2Fspotdl.vb2007.hu%2Flogin%2Fcallback&state=<state>&code_challenge=<challenge>&code_challenge_method=S256&nonce=<nonce>
    ```

    `state` and `nonce` are 1 to 512 characters each, and `redirect_uri` must be exactly one of the client's `redirectUris`.

2. **The API checks it and hands it to the site.** A valid request redirects to `<BASE_SITE_URL>/authorize?<the same parameters>`. An unknown, missing or repeated `client_id`, or a `redirect_uri` that is missing, repeated or not on the client's list, never goes back to the app: it redirects to `<BASE_SITE_URL>/authorize?error=invalid_client` or `?error=invalid_redirect_uri`, for the page to show. Any other problem goes back to the app's `redirect_uri` with `error=unsupported_response_type` (a `response_type` other than `code`) or `error=invalid_request` (any other parameter missing or repeated, `plain` or no PKCE method, a challenge that isn't 43 base64url characters, a too long `state` or `nonce`), and the `state` when it is valid.

3. **The user approves on the site.** The authorize page shows the app's name from `GET /oauth/clients/:clientId` (`{ id, name, scopes }` with `scopes` the client's [app scopes](#app-scopes) as `<client>:<scope>`, public; `404` for an unknown client or one without redirect URIs). Without a session, the user logs in there first, with any method. Then the page sends `POST /oauth/authorize` with the session cookie and a JSON body of the same parameters plus `approve: true` or `false`. It checks everything again and answers `400 { error }` on a problem, else `200 { redirectTo }`:
    - denied: `<redirect_uri>?error=access_denied&state=<state>`;
    - approved: `<redirect_uri>?code=<code>&state=<state>`, with a new one-time code.

    The parameters are added to any query the `redirect_uri` already has. The page sends the browser to `redirectTo`. Each account can send 30 of these a minute.

4. **The app exchanges the code.** On its callback, the app checks the `state`, then its server calls `POST /oauth/token` with its [client credentials](#client-authentication) and a form (`application/x-www-form-urlencoded`, or JSON) body:

    ```
    grant_type=authorization_code&code=<code>&redirect_uri=<the same redirect_uri>&code_verifier=<verifier>
    ```

    It answers the identity with `Cache-Control: no-store`, and the app checks the `nonce` against its own:

    ```json
    { "sub": "6745a1f2c3d4e5f601234567", "email": "user@example.com", "email_verified": true, "username": "someone", "isSuperuser": false, "nonce": "<nonce>" }
    ```

    `sub` is the account id, the same `id` [`POST /oauth/accounts/status`](#post-oauthaccountsstatus) answers. There's no access or ID token: the app keeps its own session for the user. The exchange creates or changes no session on vb2007.hu.

### Codes

A code is 32 random bytes as base64url. Only its SHA-256 is stored, in the `oauthcodes` collection (`_id` the hash, with the client id, the `redirect_uri`, the `code_challenge`, the `nonce`, the account id and `expiresAt`), and MongoDB's TTL index removes it after it expires. It is valid for 60 seconds and works once: whenever an exchange sends a single `code`, it is deleted before anything else is checked, so a failed exchange uses it up too, even one by another client or with a wrong `grant_type`. Suspending the account (or lifting a suspension) deletes its codes.

### Token errors

Errors answer `400` with the RFC 6749 §5.2 body `{ "error": "…", "error_description": "…" }` and `Cache-Control: no-store`:

| `error` | When |
| --- | --- |
| `unsupported_grant_type` | `grant_type` isn't `authorization_code` |
| `invalid_request` | `grant_type`, `code`, `redirect_uri` or `code_verifier` is missing or repeated, or the `code_verifier` isn't 43 to 128 characters from `A-Z a-z 0-9 - . _ ~` (its own `error_description`) |
| `invalid_grant` | The code is unknown, expired, already used or another client's; the `redirect_uri` differs from the authorization request's; the verifier's SHA-256 isn't the `code_challenge`; or the account was deleted or suspended since |

Wrong client credentials answer `401 invalid_client`, like every client route.

## Client authentication

A client sends its id and secret as HTTP Basic credentials, `Authorization: Basic base64(<id>:<secret>)`, on every request (`authenticateClient` in `src/middlewares/index.ts`, which sets `req.oauthClient`). Missing, malformed, unknown or wrong credentials answer `401` with `WWW-Authenticate: Basic realm="vb2007.hu"` and the RFC 6749 §5.2 body `{ "error": "invalid_client", "error_description": "…" }`, which OAuth client libraries read. A session cookie or an API key doesn't count.

## Endpoints

### `POST /oauth/accounts/status`

Needs a client registered with `accountStatus: true`, else `403`. Lets an app learn the current state of its users' accounts, to end its sessions of suspended or deleted accounts and keep usernames and the superuser flag current. JSON body with `emails`, `subs` (account ids) or both, 1 to 200 entries in all:

```json
{ "emails": ["user@example.com"], "subs": ["6745a1f2c3d4e5f601234567"] }
```

It answers one entry per requested item, the `emails` first, then the `subs`, each in the order sent:

```json
{
    "accounts": [
        { "email": "user@example.com", "exists": true, "id": "6745a1f2c3d4e5f601234567", "username": "someone", "isSuperuser": false, "suspendedAt": null },
        { "sub": "6745a1f2c3d4e5f601234567", "exists": true, "id": "6745a1f2c3d4e5f601234567", "username": "someone", "isSuperuser": false, "suspendedAt": null }
    ]
}
```

- E-mail addresses are matched trimmed and lowercase, like logins. A `sub` is matched ignoring case, and its entry echoes it as sent while `id` is always lowercase, so an app should store and send the `id`. A `sub` that isn't a 24 character hex id just doesn't exist.
- An account that doesn't exist answers `{ "email" | "sub", "exists": false }`. `suspendedAt` is when the account was suspended, `null` when it isn't. Nothing else about the account is shown.
- A body that isn't an object, lists that aren't lists of strings, or no or over 200 entries answer `400`.

### `POST /oauth/introspect`

Checks an API key a user gave the app, like RFC 7662 token introspection. JSON body (form-encoded bodies aren't read):

```json
{ "token": "vbk_…" }
```

A key that exists, hasn't expired, whose account isn't suspended and that holds at least one of the calling client's [app scopes](#app-scopes) answers:

```json
{ "active": true, "sub": "6745a1f2c3d4e5f601234567", "email": "user@example.com", "username": "someone", "scopes": ["spotdl:submit"], "expiresAt": "2027-02-19T10:00:00.000Z" }
```

- `scopes` lists only the calling client's app scopes the key holds, never its other scopes. `expiresAt` is `null` for a key that never expires.
- Anything else answers `200` with `{ "active": false }` and nothing more: a token that isn't shaped like a key, an unknown, expired or deleted key, a suspended account, or a key without the client's scopes (one holding only another client's app scope, say).
- A body without a `token` string answers `400` (`Send the API key to check as token, a string.`).
- An active answer updates the key's `lastUsedAt`, at most once a minute as on any [key use](./api-keys.md#authenticating-with-a-key). An inactive one never does, so a client can't touch keys it can't use.
- The route's own answers carry `Cache-Control: no-store`; the invalid JSON `400` and the `413` of the shared body handling don't. The app may cache an answer for about a minute, so a deleted key stops working there within that time.

## App scopes

Each scope a registered client lists in `scopes` makes an app scope `<client id>:<scope>` (e.g. `spotdl:submit`) that users can pick in [`POST /user/api-keys`](./api-keys.md#post-userapi-keys) next to the [built-in scopes](./api-keys.md#scopes). App scopes allow no route of this API: a key holding only app scopes answers the missing-scope `403` on every key route, and the session-only routes refuse it like any key. They only make the key `active` in that client's `POST /oauth/introspect`. Removing a client or one of its scopes from the registry makes the keys holding it inactive there, while the keys keep listing the old scope, and rotating such a key keeps it too. Registering that client id and scope again makes those keys active again, so never reuse a removed id or scope for a different app. `POST /user/api-keys` refuses an app scope whose client or scope isn't registered.

## Limits

The numbers are in `src/constants/limits.ts` and the limiters in `src/middlewares/rateLimit.ts`.

- Rejected client credentials count 10 per client IP per 15 minutes (`clientChecksPerIp`). Over that, wrong credentials from that IP answer `429` until the window ends, while valid ones are never counted or limited by it, so parallel calls from an app's server don't trip it. Counting per IP, not per client, keeps someone who knows a client's public id from locking the app out. A request with wrong credentials whose connection closes before its answer still counts. The superuser can clear it with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) and the `ip`.
- Each client can make 120 requests a minute to `POST /oauth/accounts/status`, whatever their answer (`accountStatusPerClient`, keyed by the client id), cleared by `DELETE /admin/rate-limits` with the `clientId`. Later client routes get limiters of their own, so they don't share this budget.
- Each client can fail 200 `POST /oauth/token` exchanges (the [token errors](#token-errors) above, not invalid JSON) per 15 minutes (`tokenExchangesPerClient`, keyed by the client id). Failures over the limit answer `429` instead of `400`; valid exchanges are never limited, so junk codes sent to an app's callback can't block its users' sign-ins. Cleared by `DELETE /admin/rate-limits` with the `clientId`.
- Each account can send 30 `POST /oauth/authorize` requests a minute, whatever their answer (`authorizationsPerAccount`), cleared by `DELETE /admin/rate-limits` with the account's `email`.
- `POST /oauth/introspect`'s inactive checks count 1000 per client per 15 minutes (`inactiveIntrospectionsPerClient`, keyed by the client id, cleared by `DELETE /admin/rate-limits` with the `clientId`). Inactive checks over the limit answer `429` (`Too many inactive tokens were checked by this client: try again later.`) until the window ends; active ones are never limited, so a live key holding the client's scope keeps working however many bad ones came before it. Tokens that aren't shaped like a key (they never reach the database) and `400`s aren't counted. Counting per client rather than per client IP (all of an app's checks come from its server) keeps one user's bad key from costing other users anything, and its own budget keeps junk keys from blocking the client's other routes. An app should still check the token's shape (`vbk_` and 43 base64url characters) before asking and cache inactive answers as well as active ones, so junk keys don't use up its budget.

All of them answer `429` with `{ error, retryAfter }`, a `Retry-After` header and the `RateLimit` headers, like the other limiters. Since valid credentials skip `clientChecksPerIp`, their answers carry only the per-client limiter's `RateLimit` and `RateLimit-Policy` headers, which on `POST /oauth/introspect` only its inactive answers have.

The per-IP lockout only slows guessing down: spread over many IPs, guesses keep going, and a correct guess is never blocked. A client's resistance to brute force therefore rests on its secret's entropy, so always make secrets with the [one-liner above](#client-registry) (256 random bits), never pick one by hand.
