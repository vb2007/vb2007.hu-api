# Admin endpoints

Superuser-only endpoints for managing users, their upload quotas and pending registrations. The superuser is the account whose e-mail matches `SUPERUSER_EMAIL` (see [dotenv-setup](./dotenv-setup.md)), logged in with the `VB-AUTH` cookie.

| Route | What it does |
| --- | --- |
| `GET /admin/users` | Lists users with their upload usage and quota |
| `PATCH /admin/users/:id/upload-quota` | Sets or resets a user's upload quota |
| `GET /admin/users/:id/uploads` | Lists a user's uploads, private ones included |
| `GET /admin/pending-registrations` | Lists the sign-ups waiting for their code |
| `DELETE /admin/pending-registrations/:id` | Removes a pending registration before it expires |

Every route answers:

| Status | `error` | When |
| --- | --- | --- |
| `400` | `The request body must be valid JSON: an object or an array.` | The body isn't valid JSON, or isn't an object/array (e.g. `5` or `null`). Checked before anything else, login included |
| `403` | `You must be logged in to perform this action.` | No `VB-AUTH` cookie, or an unknown or expired session |
| `403` | `You do not have permission to perform this action.` | Logged in, but not as the superuser |
| `500` | `Something went wrong on the server: please try again later.` | Unexpected errors, e.g. the database being down |

## Users

Each user, in both `GET /admin/users` and the quota response, looks like this:

```json
{
    "id": "64b7f0c2a1b2c3d4e5f60718",
    "username": "example",
    "email": "example@example.com",
    "createdAt": "2026-01-15T10:00:00.000Z",
    "isSuperuser": false,
    "uploads": { "usedBytes": 140, "count": 2, "quotaBytes": 10737418240, "hasCustomQuota": false }
}
```

- `createdAt` falls back to the id's timestamp for users made before the field existed.
- `quotaBytes` is the user's own quota when `hasCustomQuota` is `true`, otherwise the default from `UPLOAD_USER_QUOTA_MB`, `10240` MB when unset.

## `GET /admin/users`

Query parameters, all optional:

| Parameter | Values | Default |
| --- | --- | --- |
| `limit` | Integer, `1`–`50` | `20` |
| `page` | Integer, `1` or more | `1` |
| `sortBy` | `usedBytes`, `username` (case-insensitive) or `createdAt` | `usedBytes` |
| `sortOrder` | `asc` or `desc` | `desc` |
| `q` | Case-insensitive part of the username, up to 100 characters | none |

An invalid value, or a parameter given twice, answers `400` `Invalid value for <parameter>.`, naming the first invalid one in the table's order. An empty `q=` means no filter, while an empty value for any other parameter is invalid. Unknown parameters are ignored.

```json
{
    "users": [{ "id": "64b7f0c2a1b2c3d4e5f60718", "username": "example", "...": "..." }],
    "pagination": { "limit": 20, "page": 1, "total": 1, "pages": 1, "sortBy": "usedBytes", "sortOrder": "desc" }
}
```

`total` counts the users matching `q`. A page past the last one answers `200` with an empty `users`; `pages` is `0` when nothing matches.

## `PATCH /admin/users/:id/upload-quota`

JSON body:

| Field | Values |
| --- | --- |
| `quotaBytes` | Integer from `0` up to `9007199254740991` (`Number.MAX_SAFE_INTEGER`) bytes, or `null` to go back to the default quota |

```json
{ "message": "Upload quota updated successfully.", "user": { "id": "64b7f0c2a1b2c3d4e5f60718", "...": "..." } }
```

`user` has the shape above, with the new quota. A quota below the user's usage is accepted: their files stay, but every new upload answers `413`.

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid ID format: must be a 24 character HEX string.` | Invalid `:id` |
| `404` | `There is no such user with that ID.` | No such user, checked before `quotaBytes` |
| `400` | `quotaBytes must be a whole number of bytes from 0, or null for the default quota.` | `quotaBytes` is missing, negative, fractional, too large or not a number (e.g. `"100"`) |

## `GET /admin/users/:id/uploads`

Query parameters, all optional, with the same rules as `GET /admin/users`:

| Parameter | Values | Default |
| --- | --- | --- |
| `limit` | Integer, `1`–`50` | `20` |
| `page` | Integer, `1` or more | `1` |
| `sortBy` | `uploadedOn`, `originalFileName` (case-insensitive) or `fileSize` | `uploadedOn` |
| `sortOrder` | `asc` or `desc` | `desc` |
| `visibility` | `public` or `private` | both |
| `q` | Case-insensitive part of the original file name, up to 100 characters | none |

```json
{
    "user": { "id": "64b7f0c2a1b2c3d4e5f60718", "username": "example" },
    "uploads": [
        {
            "id": "64b7f1d3b2c3d4e5f6071829",
            "originalFileName": "photo.png",
            "extension": ".png",
            "mimeType": "image/png",
            "fileSize": 70,
            "visibility": "private",
            "url": "https://cdn.vb2007.hu/useruploads/64b7f0c2a1b2c3d4e5f60718/64b7f1d3b2c3d4e5f6071829.png",
            "uploadedOn": "2026-01-15T10:05:00.000Z",
            "updatedOn": "2026-01-15T10:05:00.000Z"
        }
    ],
    "pagination": { "limit": 20, "page": 1, "total": 1, "pages": 1, "sortBy": "uploadedOn", "sortOrder": "desc" }
}
```

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid ID format: must be a 24 character HEX string.` | Invalid `:id` |
| `400` | `Invalid value for <parameter>.` | An invalid query parameter, checked before the user exists |
| `404` | `There is no such user with that ID.` | No such user |

## `GET /admin/pending-registrations`

Lists the sign-ups started with `POST /auth/register` whose code hasn't been verified yet. A pending registration only holds the e-mail address: the username and password are given at `POST /auth/register/verify`. The code, its attempts and failed guesses are never returned.

Query parameters, all optional, with the same rules as `GET /admin/users`:

| Parameter | Values | Default |
| --- | --- | --- |
| `limit` | Integer, `1`–`50` | `20` |
| `page` | Integer, `1` or more | `1` |
| `q` | Case-insensitive part of the e-mail address, up to 100 characters | none |

```json
{
    "pendingRegistrations": [
        { "id": "64b7f2e4c3d4e5f60718293a", "email": "example@example.com", "expiresAt": "2026-01-16T10:00:00.000Z" }
    ],
    "pagination": { "limit": 20, "page": 1, "total": 1, "pages": 1 }
}
```

- The newest sign-ups come first, by `expiresAt`: 24 hours after the last `POST /auth/register` for the address. Resending the code doesn't move it.
- `total` counts the pending registrations matching `q`. A page past the last one answers `200` with an empty `pendingRegistrations`; `pages` is `0` when nothing matches.

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid value for <parameter>.` | An invalid query parameter |

## `DELETE /admin/pending-registrations/:id`

Removes a pending registration before its 24-hour expiry, with its code and its daily count of wrong codes. The removed code no longer verifies, and a verification already past its code check fails with `400` `The code is wrong, expired or already used: check it or request a new one.` instead of creating the account; once the account is created, the delete answers `404`.

The address can start registering again straight away. Verifying can still answer `429` for up to 15 minutes after earlier wrong guesses, as the per-address limit on wrong codes (see the [account rules](../README.md#account-rules)) is kept in the API's memory, not on the pending registration.

```json
{ "message": "Pending registration removed successfully." }
```

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid ID format: must be a 24 character HEX string.` | Invalid `:id` |
| `404` | `There is no such pending registration with that ID.` | No such pending registration, e.g. already verified or removed |

A pending registration past its `expiresAt` is still listed and can still be removed with `200` until MongoDB's TTL monitor deletes it, which runs about every 60 seconds.
