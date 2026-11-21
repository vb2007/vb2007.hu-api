# API keys

Users can create API keys for scripts and other programs. This page covers storing and managing them. Authenticating requests with a key arrives in a follow-up change: until then a key can't be used on any route.

## Tokens and storage

- A token is `vbk_` followed by 32 random bytes in base64url (47 characters). The prefix makes a leaked token easy to spot, for example by secret scanning or `grep`.
- The token is shown once, in the answer that creates or rotates the key, which carries `Cache-Control: no-store`. The API stores only its HMAC-SHA256 (`hashApiKey` in `src/helpers/apiKeys.ts`, keyed with `CRYPTO_SECRET_KEY`), so a lost token can't be shown again: rotate the key or create a new one.
- Keys are stored on the user as `authentication.apiKeys[]`: an id (32 hex characters), the name, the hash, a hint (the token's last 4 characters, to tell keys apart), the scopes, `createdAt`, `expiresAt` (none for a key that never expires) and `lastUsedAt`. Deleting the account deletes them with it. A unique index on `authentication.apiKeys.hash` (migration `010-api-key-index`) keeps one token from belonging to two keys.
- An account can have at most 10 keys (`API_KEYS_MAX`). The cap is checked in the same write that adds the key, so parallel requests can't go past it.

## Scopes

A key gets an explicit list of scopes, each allowing one kind of request. A `write` scope doesn't include its `read` scope.

| Scope | For |
| --- | --- |
| `account:read`, `account:write` | The account's own details |
| `pastes:read`, `pastes:write` | Pastes |
| `shortUrls:read`, `shortUrls:write` | Short URLs |
| `uploads:read`, `uploads:write` | Uploads |
| `admin:read`, `admin:write` | The [admin endpoints](./admin-endpoints.md) |

Only the superuser (`SUPERUSER_EMAIL`) can give a key the `admin:` scopes.

Account security (password, e-mail address, account deletion, MFA, passkeys, GitHub link, logout) and the API keys themselves are never reachable with a key, only with a session.

## Lifecycle

- A key expires after `expiresInDays` days: 1 to 365, 90 by default, or `null` for a key that never expires.
- A password reset (with a code or a link), a suspension and an [admin MFA reset](./admin-endpoints.md#delete-adminusersidmfa) delete every key of the account, since each of them means the account may be in the wrong hands.
- A password change, an e-mail change and logging out keep the keys: delete them yourself if they may have leaked.

## Managing keys

These need a logged-in session (`__Host-VB-AUTH`), else `403` with `You must be logged in to perform this action.`

Creating and rotating a key need the owner to confirm, the same way as [adding a passkey](./passkeys.md#confirming-its-the-owner): the password as `{"password": "…"}` (`400` when missing, `403` when wrong, counted against the per-account and per-IP limits of the [README](../README.md#account-rules)), or, on an account without a password, a GitHub login within the last 10 minutes (else `403`). The key is only written while the session is still live and the password unchanged (or the GitHub confirmation still recent), else `403` and nothing changes. Deleting a key needs no confirmation.

Creating, rotating and deleting a key mail the account's address a [security notice](./email-setup.md#security-notices) with the key's name; for a key with `admin:` scopes it says so.

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

### `POST /user/api-keys/:id/rotate`

Body: `{"expiresInDays": …, "password": "…"}`. Gives the key a new token and answers `200` like `POST /user/api-keys`; the old token stops working at once. The name and scopes stay. `createdAt` becomes the time of the rotation and `lastUsedAt` goes back to `null`. Without `expiresInDays` the key keeps the lifetime it had (90 days from creation stays 90 days from the rotation, and a key that never expires still doesn't); with it, the new lifetime starts now.

`404` (`There is no such API key on this account.`) for an id that isn't one of the account's keys, `400` for a bad `expiresInDays`, and the confirmation's answers as above.

### `DELETE /user/api-keys/:id`

Deletes the key at once and answers `200` (`API key deleted successfully.`), or `404` for an id that isn't one of the account's keys.
