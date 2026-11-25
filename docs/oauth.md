# OAuth clients

First-party apps (the first one is spotdl-web) talk to the API server-to-server as registered clients. This page covers registering a client, authenticating as one and the routes clients can call.

## Client registry

The clients live in the `OAUTH_CLIENTS` variable of `.env`: one line holding a JSON array, wrapped in single quotes so neither dotenv nor `docker compose` (`env_file: .env`) changes it (without them, dotenv cuts the value at a `#` and compose expands `$`). Without it there are no clients. Each client is:

| Field | What it is |
| --- | --- |
| `id` | The public client id: 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit. Unique, and not an [API key scope](./api-keys.md#scopes)'s prefix (`account`, `pastes`, `shorturls`, `uploads`, `admin`) |
| `name` | Display name, not blank |
| `secretHash` | The client secret's SHA-256, as 64 lowercase hex digits. The secret itself is only given to the app |
| `redirectUris` | Absolute `http:` or `https:` URLs without a fragment (RFC 6749 §3.1.2) the client may be sent back to, matched exactly. May be empty |
| `scopes` | The client's own scope names, distinct, 1 to 64 lowercase letters, digits or hyphens each. May be empty |

Any other field (a plaintext `secret`, say) stops the API too.

```dotenv
OAUTH_CLIENTS='[{"id":"spotdl","name":"spotdl-web","secretHash":"<sha256 hex>","redirectUris":["https://spotdl.vb2007.hu/login/callback"],"scopes":["submit"]}]'
```

The API checks the list when it starts (`src/helpers/oauthClients.ts`) and refuses to start when it isn't valid JSON or an entry breaks a rule above, naming the entry. Changing it takes a restart.

To make a client's secret and its hash, run this, give the app the secret and put the hash in `secretHash`:

```bash
secret=$(openssl rand -hex 32); echo "secret: $secret"; echo "secretHash: $(printf %s "$secret" | sha256sum | cut -d' ' -f1)"
```

Keep the secret to hex (or other characters that need no URL encoding): the API reads the Basic credentials as they are, without the form decoding RFC 6749 asks clients to apply.

## Client authentication

A client sends its id and secret as HTTP Basic credentials, `Authorization: Basic base64(<id>:<secret>)`, on every request (`authenticateClient` in `src/middlewares/index.ts`, which sets `req.oauthClient`). Missing, malformed, unknown or wrong credentials answer `401` with `WWW-Authenticate: Basic realm="vb2007.hu"`. A session cookie or an API key doesn't count.

## Endpoints

### `POST /oauth/accounts/status`

Lets an app learn the current state of its users' accounts, to end its sessions of suspended or deleted accounts and keep usernames and the superuser flag current. JSON body with `emails`, `subs` (account ids) or both, 1 to 200 entries in all:

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

- E-mail addresses are matched trimmed and lowercase, like logins. A `sub` that isn't a 24 character hex id just doesn't exist.
- An account that doesn't exist answers `{ "email" | "sub", "exists": false }`. `suspendedAt` is when the account was suspended, `null` when it isn't. Nothing else about the account is shown.
- A body that isn't an object, lists that aren't lists of strings, or no or over 200 entries answer `400`.

## Limits

The numbers are in `src/constants/limits.ts` and the limiters in `src/middlewares/rateLimit.ts`.

- Rejected client credentials count 10 per client IP per 15 minutes (`clientChecksPerIp`). Over that, wrong credentials from that IP answer `429` until the window ends, while valid ones are never counted or limited by it, so parallel calls from an app's server don't trip it. Counting per IP, not per client, keeps someone who knows a client's public id from locking the app out. A request with wrong credentials whose connection closes before its answer still counts. The superuser can clear it with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) and the `ip`.
- Each client can make 120 requests a minute to `POST /oauth/accounts/status`, whatever their answer (`clientRequestsPerClient`, keyed by the client id). `DELETE /admin/rate-limits` doesn't clear it.

Both answer `429` with `{ error, retryAfter }`, a `Retry-After` header and the `RateLimit` headers, like the other limiters.
