# Admin endpoints

Superuser-only endpoints for managing users and their upload quotas. The superuser is the account whose e-mail matches `SUPERUSER_EMAIL` (see [dotenv-setup](./dotenv-setup.md)), logged in with the `VB-AUTH` cookie.

| Route | What it does |
| --- | --- |
| `GET /admin/users` | Lists users with their upload usage and quota |
| `PATCH /admin/users/:id` | Renames a user |
| `PATCH /admin/users/:id/upload-quota` | Sets or resets a user's upload quota |
| `GET /admin/users/:id/uploads` | Lists a user's uploads, private ones included |
| `DELETE /admin/users/:id` | Deletes a user with their pastes, short links and uploads |

Every route answers:

| Status | `error` | When |
| --- | --- | --- |
| `400` | `The request body must be valid JSON: an object or an array.` | The body isn't valid JSON, or isn't an object/array (e.g. `5` or `null`). Checked before anything else, login included |
| `403` | `You must be logged in to perform this action.` | No `VB-AUTH` cookie, or an unknown or expired session |
| `403` | `You do not have permission to perform this action.` | Logged in, but not as the superuser |
| `500` | `Something went wrong on the server: please try again later.` | Unexpected errors, e.g. the database being down |

## Users

Each user, in `GET /admin/users` and the rename and quota responses, looks like this:

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
| `q` | Case-insensitive part of the username or e-mail address, up to 100 characters | none |

An invalid value, or a parameter given twice, answers `400` `Invalid value for <parameter>.`, naming the first invalid one in the table's order. An empty `q=` means no filter, while an empty value for any other parameter is invalid. Unknown parameters are ignored.

```json
{
    "users": [{ "id": "64b7f0c2a1b2c3d4e5f60718", "username": "example", "...": "..." }],
    "pagination": { "limit": 20, "page": 1, "total": 1, "pages": 1, "sortBy": "usedBytes", "sortOrder": "desc" }
}
```

`total` counts the users matching `q`. A page past the last one answers `200` with an empty `users`; `pages` is `0` when nothing matches.

## `PATCH /admin/users/:id`

JSON body:

| Field | Values |
| --- | --- |
| `username` | 2 to 16 characters after trimming, by the same [rules](../README.md#account-rules) as `PATCH /users/:id` |

```json
{ "message": "Username updated successfully.", "user": { "id": "64b7f0c2a1b2c3d4e5f60718", "username": "renamed", "...": "..." } }
```

`user` has the shape above, with the new username. Renaming a user to another case of their own name is allowed. The superuser can rename their own account too: superuser status follows the e-mail, so it is unaffected. `PATCH /users/:id` stays limited to the account's owner.

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid ID format: must be a 24 character HEX string.` | Invalid `:id` |
| `404` | `There is no such user with that ID.` | No such user, checked before `username` |
| `400` | `You must provide a username.` | `username` is missing, empty or not a string |
| `400` | `The username's too short: it must be between 2 and 16 characters.` | Under 2 characters after trimming |
| `400` | `The username's too long: it must be between 2 and 16 characters.` | Over 16 characters after trimming |
| `409` | `This username is already taken.` | Another user has the name, or one that counts as the same (e.g. another case) |

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

## `DELETE /admin/users/:id`

Deletes the user with everything they own: their pastes, short links, upload records and upload folder (`<UPLOAD_DISK_DIRECTORY>/<id>`). There's no password re-check: the superuser's session is the guard. The user's session ends with the account, so their `VB-AUTH` cookie answers `403` afterwards.

```json
{ "message": "User deleted successfully." }
```

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid ID format: must be a 24 character HEX string.` | Invalid `:id` |
| `404` | `There is no such user with that ID.` | No such user |
| `409` | `The superuser's own account can't be deleted.` | `:id` is the superuser's account |
