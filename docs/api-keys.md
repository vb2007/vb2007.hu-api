# API keys

Users can create API keys for scripts and other programs. This page covers storing and managing them and authenticating requests with them.

## Tokens and storage

- A token is `vbk_` followed by 32 random bytes in base64url (47 characters). The prefix makes a leaked token easy to spot, for example by secret scanning or `grep`.
- The token is shown once, in the answer that creates or rotates the key, which carries `Cache-Control: no-store`. The API stores only an HMAC-SHA256 made from it (`hashApiKey` in `src/helpers/apiKeys.ts`, through the `authentication()` helper also used for the reset links: `apiKey/<token>` is the HMAC key and `CRYPTO_SECRET_KEY` the message), so a lost token can't be shown again: rotate the key or create a new one.
- Keys are stored on the user as `authentication.apiKeys[]`: an id (32 hex characters), the name, the hash, a hint (the token's last 4 characters, to tell keys apart), the scopes, `createdAt`, `expiresAt` (none for a key that never expires) and `lastUsedAt`. Deleting the account deletes them with it. A unique index on `authentication.apiKeys.hash` (migration `010-api-key-index`) keeps one token from belonging to two keys.
- An account can have at most 10 keys (`API_KEYS_MAX`). The cap is checked in the same write that adds the key, so parallel requests can't go past it.

## Scopes

A key gets an explicit list of scopes, each allowing one kind of request. A `write` scope doesn't include its `read` scope.

| Scope | Routes |
| --- | --- |
| `account:read` | `GET /user` |
| `account:write` | `PATCH /users/:id` (the key's own account only) |
| `pastes:read` | `GET /pastes/:username` |
| `pastes:write` | `POST /paste`, `PATCH /paste/:id`, `DELETE /paste/:id` |
| `shortUrls:read` | `GET /shortenUrls` |
| `shortUrls:write` | `POST /shortenUrl`, `DELETE /shortenUrl/:shortenedUrl` |
| `uploads:read` | `GET /uploads/usage`, `GET /uploads`, `GET /upload/:id` |
| `uploads:write` | `POST /upload` (multipart works the same as with a session), `PATCH /upload/:id`, `DELETE /upload/:id` |
| `admin:read` | Every `GET /admin/…` [admin endpoint](./admin-endpoints.md) |
| `admin:write` | Every other `/admin/…` endpoint, except `DELETE /admin/rate-limits` (session only, below) |

Only the superuser (`SUPERUSER_EMAIL`) can give a key the `admin:` scopes, and the admin endpoints still check on every request that the key's account is the superuser's, so a key loses them once `SUPERUSER_EMAIL` changes. The public routes (`GET /paste/:id`, `GET /shortenUrl/:shortenedUrl`, `GET /r/:shortenedUrl`, `GET /uploads/access`) need no key. A private upload's file is fetched through the signed URL that `GET /upload/:id` answers with, not with the key.

A key acts as its account: it changes only that account's own pastes, short URLs, uploads and username, and changing or reading another user's (`PATCH`/`DELETE /paste/:id`, `DELETE /shortenUrl/:shortenedUrl`, `GET`/`PATCH`/`DELETE /upload/:id`, `PATCH /users/:id`) answers `403` (or `404` when there's no such item). `GET /pastes/:username` lists any user's pastes, as it does for any session. The superuser's session can edit and delete everyone's, but the superuser's keys only with `admin:write`: a superuser key with content scopes alone acts like any other user's.

Account security (password, e-mail address, account deletion, MFA, passkeys, GitHub link, logout), the API keys themselves and [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) are never reachable with a key, only with a session: they answer `403` to any `Authorization` header, even next to a valid session (`POST /auth/logout` then keeps the session, and the GitHub link callback redirects with `oauthError=apiKeyNotAccepted`). A leaked key then can't take the account over or make itself new keys, nor clear the brute-force limits of an account, the superuser's own included, to guess its password without bound. The account security routes keep their checks that the session is still live and the password unchanged, which a key can't give.

## Authenticating with a key

Send the token in the `Authorization` header, never in the URL or a cookie:

```shell
curl -H "Authorization: Bearer vbk_…" https://api.vb2007.hu/user
```

- The header has to be `Bearer` (in any case), one space and the token (`vbk_` and 43 base64url characters), sent once: a request with two `Authorization` headers answers `401`. Browsers never send it on their own, so a key needs no CSRF protection, and CORS allows it from the configured origins (`CORS_ORIGIN_URLS`) only.
- With an `Authorization` header the request is authenticated by the key alone: the `__Host-VB-AUTH` cookie is ignored, so a bad key next to a valid session still answers `401`. Without the header the routes above take the session as before.
- A valid key's `lastUsedAt` is updated while the request is authenticated, also when the key lacks the route's scope, at most once a minute. The write doesn't hold up the answer, and a failed one doesn't fail the request.

| Status | `error` | When |
| --- | --- | --- |
| `401` | `The API key is malformed, unknown, expired or revoked: send it as Authorization: Bearer vbk_….` | The header isn't `Bearer vbk_…`, or the key is unknown, expired, deleted, rotated out or its account suspended |
| `403` | `This API key doesn't have the <scope> scope needed here.` | The key is valid but lacks the route's scope |
| `403` | `This action needs a logged-in session: API keys aren't accepted here.` | Any `Authorization` header on a session-only route |
| `429` | `Too many failed attempts: try again later.` | Too many rejected keys from the client IP, below |

The `401`s carry `WWW-Authenticate: Bearer realm="vb2007.hu", error="invalid_token"`, and the missing scope's `403` `WWW-Authenticate: Bearer realm="vb2007.hu", error="insufficient_scope", scope="<scope>"` ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750#section-3)), exposed to the CORS origins like `Retry-After`.

Rejected keys (the `401`s) count 100 per client IP per 15 minutes (`apiKeyChecksPerIp`, cleared by [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) with the superuser's session); over that, the routes above answer `429` to every request with an `Authorization` header from that IP until the window ends, while the session-only routes keep answering `403`. Other answers to a valid key, like a `404` for a paste that doesn't exist or a missing scope's `403`, don't count, except that a request whose connection closes before its answer counts whatever its result, like on the other limiters ([README](../README.md#account-rules)). Requests without the header aren't limited by it.

## Lifecycle

- A key expires after `expiresInDays` days: 1 to 365, 90 by default, or `null` for a key that never expires.
- A password reset (with a code or a link), a suspension and an [admin MFA reset](./admin-endpoints.md#delete-adminusersidmfa) delete every key of the account, since each of them means the account may be in the wrong hands.
- A password change, an e-mail change and logging out (an [admin logout](./admin-endpoints.md#post-adminusersidlogout) too) keep the keys: delete them yourself if they may have leaked. The superuser can revoke all of a user's keys with [`DELETE /admin/users/:id/api-keys`](./admin-endpoints.md#delete-adminusersidapi-keys).

## Managing keys

These need a logged-in session (`__Host-VB-AUTH`), else `403` with `You must be logged in to perform this action.`

Creating and rotating a key need the owner to confirm, the same way as [adding a passkey](./passkeys.md#confirming-its-the-owner): the password as `{"password": "…"}` (missing, empty or not a string answers `400` `You must provide your password to create or rotate an API key.`, a wrong one `403` `The provided password is incorrect.`, counted against the per-account and per-IP limits of the [README](../README.md#account-rules)), or, on an account without a password, a GitHub login within the last 10 minutes (else `403` `Confirm it's you first: log in with GitHub again (or relink it), then create or rotate the API key within 10 minutes.`). The key is only written while the session is still live and the password unchanged (or the GitHub confirmation still recent), else `403` (`You must be logged in to perform this action.`, or on an account without a password the GitHub error above) and nothing changes. A create on an account that already had 10 keys, or a rotate of a key that was already gone, answers its `409` or `404` even if the session ends during the request. Deleting a key needs no confirmation.

Creating, rotating and deleting a key mail the account's address a [security notice](./email-setup.md#security-notices) with the key's name; for a key with `admin:` scopes it says so. Since a key made from a hijacked session would otherwise appear without a word, creating and rotating take one of the day's 10 notices of the account (`SECURITY_NOTICES_PER_DAY`) after the confirmation and the checks below, before writing anything: once they're used up, both answer `429` (`Too many security notices were mailed to this account today, and API keys can't be created or rotated without one: try again tomorrow.`) with `retryAfter` (seconds until the 24 hours of the notice count end) and a `Retry-After` header, and change nothing. A create on an account that already has 10 keys answers `409` before taking one. A request that then fails anyway (a key added or a rotation finished by a parallel request, or a session that ended meanwhile) gives its notice back. Deleting a key keeps working and only mails while notices are left. Only the account's notice is taken before the write: the site's [share for security notices](./email-setup.md#limits) is checked when the notice is sent, so once the day's share is used up a key is still created or rotated and its notice isn't sent, as for [passkeys](./passkeys.md), which take no notice before the write at all.

### `GET /user/api-keys`

```json
{
    "apiKeys": [
        {
            "id": "3f0c9a7e5b1d4c2a8e6f0b9d7c5a3e1f",
            "name": "Deploy bot",
            "hint": "x9Qk",
            "scopes": ["pastes:read", "pastes:write"],
            "createdAt": "2026-11-21T10:00:00.000Z",
            "expiresAt": "2027-02-19T10:00:00.000Z",
            "lastUsedAt": null
        }
    ]
}
```

Neither the token nor its hash is ever listed. `expiresAt` is `null` for a key that never expires.

### `POST /user/api-keys`

Body: `{"name": "…", "scopes": [...], "expiresInDays": 90, "password": "…"}`. `expiresInDays` is optional. The name is trimmed, has to be 1 to 64 characters and follows the same character rules as a [passkey name](./passkeys.md#post-userpasskeys). The request is checked before the password, so a bad one doesn't count as a password check.

Answers `201` with `message` and `apiKey`: the list item above plus `token`.

| Status | `error` | When |
| --- | --- | --- |
| `201` | | Created |
| `400` | `You must provide a name for the API key.` | `name` is missing, blank or not a string |
| `400` | `The API key name can be at most 64 characters long.` | `name` is too long |
| `400` | `The API key name can't contain line breaks or invisible formatting characters.` | `name` has a refused character |
| `400` | `scopes must be a non-empty list of distinct scopes out of: …` | `scopes` isn't an array, is empty, repeats a scope or has an unknown one |
| `400` | `expiresInDays must be a whole number of days from 1 to 365, or null for a key that never expires.` | `expiresInDays` is anything else |
| `403` | `Only the superuser can give an API key admin scopes.` | `admin:` scopes for anyone else |
| `400`/`403` | | The confirmation above failed |
| `409` | `An account can have at most 10 API keys: delete one first.` | The account already has 10 |
| `429` | `Too many security notices were mailed to this account today, …` | The day's security notices are used up |

### `POST /user/api-keys/:id/rotate`

Body: `{"expiresInDays": …, "password": "…"}`. Gives the key a new token and answers `200` like `POST /user/api-keys`; the old token stops working at once. The name and scopes stay. `createdAt` becomes the time of the rotation and `lastUsedAt` goes back to `null`. Without `expiresInDays` the key keeps the lifetime it had (90 days from creation stays 90 days from the rotation, and a key that never expires still doesn't), so rotating an expired key gives it a fresh copy of its old lifetime; with it, the new lifetime starts now.

`404` (`There is no such API key on this account.`) for an id that isn't one of the account's keys, `400` for a bad `expiresInDays`, `403` (`Only the superuser can give an API key admin scopes.`) for a key with `admin:` scopes once its account isn't the superuser's, `429` once the day's security notices are used up, and the confirmation's answers as above. When parallel rotations of one key race, the first one wins and the others answer `409` (`The API key was changed by another request at the same time: list the keys and try again.`) without changing it.

### `DELETE /user/api-keys/:id`

Deletes the key at once and answers `200` (`API key deleted successfully.`), or `404` for an id that isn't one of the account's keys.
