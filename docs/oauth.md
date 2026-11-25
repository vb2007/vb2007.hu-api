# OAuth clients

First-party apps (the first one is spotdl-web) talk to the API server-to-server as registered clients. This page covers registering a client, authenticating as one and the routes clients can call.

## Client registry

The clients live in the `OAUTH_CLIENTS` variable of `.env`: one line holding a JSON array, wrapped in single quotes so neither dotenv nor `docker compose` (`env_file: .env`) changes it (without them, dotenv cuts the value at a `#` and compose expands `$`). Without it there are no clients. Each client is:

| Field | What it is |
| --- | --- |
| `id` | The public client id: 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit. Unique, and not an [API key scope](./api-keys.md#scopes)'s prefix (`account`, `pastes`, `shorturls`, `uploads`, `admin`) |
| `name` | Display name, not blank |
| `secretHash` | The client secret's SHA-256, as 64 lowercase hex digits. The secret itself is only given to the app |
| `redirectUris` | URLs the client may be sent back to, matched exactly: `https:`, or `http:` only on `localhost`, `127.0.0.1` or `[::1]`, without a fragment (RFC 6749 §3.1.2). May be empty |
| `scopes` | The client's own scope names, distinct, 1 to 64 lowercase letters, digits or hyphens each. May be empty. Each becomes the app scope `<id>:<scope>` that users can give their API keys (see [App scopes](#app-scopes)) |
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
- Anything else answers `200` with `{ "active": false }` and nothing more: a token that isn't shaped like a key, an unknown, expired or deleted key, a suspended account, or a key without the client's scopes (a `ci-other:other` key is inactive for `ci-app`).
- A body without a `token` string answers `400` (`Send the API key to check as token, a string.`).
- A live key's `lastUsedAt` is updated at most once a minute, as on any [key use](./api-keys.md#authenticating-with-a-key), also when it lacks the client's scopes.
- Answers carry `Cache-Control: no-store`. The app may cache an answer for about a minute, so a deleted key stops working there within that time.

## App scopes

Each scope a registered client lists in `scopes` makes an app scope `<client id>:<scope>` (e.g. `spotdl:submit`) that users can pick in [`POST /user/api-keys`](./api-keys.md#post-userapi-keys) next to the [built-in scopes](./api-keys.md#scopes). App scopes allow no route of this API: a key holding only app scopes answers the missing-scope `403` on every key route, and the session-only routes refuse it like any key. They only make the key `active` in that client's `POST /oauth/introspect`. Removing a client or one of its scopes from the registry makes the keys holding it inactive there, while the keys keep listing the old scope. `POST /user/api-keys` refuses an app scope whose client or scope isn't registered.

## Limits

The numbers are in `src/constants/limits.ts` and the limiters in `src/middlewares/rateLimit.ts`.

- Rejected client credentials count 10 per client IP per 15 minutes (`clientChecksPerIp`). Over that, wrong credentials from that IP answer `429` until the window ends, while valid ones are never counted or limited by it, so parallel calls from an app's server don't trip it. Counting per IP, not per client, keeps someone who knows a client's public id from locking the app out. A request with wrong credentials whose connection closes before its answer still counts. The superuser can clear it with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) and the `ip`.
- Each client can make 120 requests a minute to `POST /oauth/accounts/status`, whatever their answer (`accountStatusPerClient`, keyed by the client id), cleared by `DELETE /admin/rate-limits` with the `clientId`. Later client routes get limiters of their own, so they don't share this budget.
- `POST /oauth/introspect`'s inactive answers count 1000 per client per 15 minutes (`inactiveIntrospectionsPerClient`, keyed by the client id, cleared by `DELETE /admin/rate-limits` with the `clientId`). Over that, every check by that client answers `429` (`Too many inactive tokens were checked by this client: try again later.`) until the window ends, live keys included, so an app shouldn't take that `429` as a revoked key. Active answers and `400`s aren't counted. Counting per client rather than per client IP keeps one user's bad key from locking every user of the app out (all its checks come from its server), and its own budget keeps junk keys from blocking the client's other routes.

All of them answer `429` with `{ error, retryAfter }`, a `Retry-After` header and the `RateLimit` headers, like the other limiters. Since valid credentials skip `clientChecksPerIp`, their answers carry only the per-client limiter's `RateLimit` and `RateLimit-Policy` headers.

The per-IP lockout only slows guessing down: spread over many IPs, guesses keep going, and a correct guess is never blocked. A client's resistance to brute force therefore rests on its secret's entropy, so always make secrets with the [one-liner above](#client-registry) (256 random bits), never pick one by hand.
