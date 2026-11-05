# Admin endpoints

Superuser-only endpoints for managing users, their upload quotas and suspensions. The superuser is the account whose e-mail matches `SUPERUSER_EMAIL` (see [dotenv-setup](./dotenv-setup.md)), logged in with the `VB-AUTH` cookie.

| Route | What it does |
| --- | --- |
| `GET /admin/users` | Lists users with their upload usage and quota |
| `PATCH /admin/users/:id/upload-quota` | Sets or resets a user's upload quota |
| `PATCH /admin/users/:id/suspension` | Suspends a user or lifts their suspension |
| `GET /admin/users/:id/uploads` | Lists a user's uploads, private ones included |

Every route answers:

| Status | `error` | When |
| --- | --- | --- |
| `400` | `The request body must be valid JSON: an object or an array.` | The body isn't valid JSON, or isn't an object/array (e.g. `5` or `null`). Checked before anything else, login included |
| `403` | `You must be logged in to perform this action.` | No `VB-AUTH` cookie, or an unknown or expired session |
| `403` | `You do not have permission to perform this action.` | Logged in, but not as the superuser |
| `500` | `Something went wrong on the server: please try again later.` | Unexpected errors, e.g. the database being down |

## Users

Each user, in `GET /admin/users` and the quota and suspension responses, looks like this:

```json
{
    "id": "64b7f0c2a1b2c3d4e5f60718",
    "username": "example",
    "email": "example@example.com",
    "createdAt": "2026-01-15T10:00:00.000Z",
    "isSuperuser": false,
    "suspendedAt": null,
    "uploads": { "usedBytes": 140, "count": 2, "quotaBytes": 10737418240, "hasCustomQuota": false }
}
```

- `createdAt` falls back to the id's timestamp for users made before the field existed.
- `suspendedAt` is when the user was suspended, or `null` while they aren't.
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

## `PATCH /admin/users/:id/suspension`

JSON body:

| Field | Values |
| --- | --- |
| `suspended` | `true` to suspend the user, `false` to lift the suspension |

```json
{ "message": "User suspended successfully: their session was ended.", "user": { "id": "64b7f0c2a1b2c3d4e5f60718", "...": "..." } }
```

`user` has the shape above. Lifting a suspension answers `User unsuspended successfully.` with `suspendedAt` back to `null`.

- Suspending ends the user's session, so their `VB-AUTH` cookie answers `403` from then on, and voids their pending password reset codes and links, e-mail change and GitHub link start, which then answer like expired ones. Lifting the suspension clears the same fields again, so nothing started around the suspension carries over and the user logs in afresh. Suspending a suspended user again keeps the first `suspendedAt`.
- A suspended user can't log in: `POST /auth/login` answers `403` `This account is suspended: it can't log in until the superuser lifts the suspension.`, but only after the right password, so a wrong one still gets the usual `403` and doesn't reveal the suspension. GitHub login redirects with `oauthError=accountSuspended` (see [github-oauth-setup](./github-oauth-setup.md#errors)).
- `POST /auth/password-reset` and `POST /auth/register/resend` mail nothing for a suspended user's address and answer like for any other address: the same `200`, and the resend keeps its usual one-minute `429`. `POST /auth/register` still mails a code to the address as for any existing account, and that code can't create an account (`409`).
- Their pastes, short URLs and uploads stay up.

| Status | `error` | When |
| --- | --- | --- |
| `400` | `Invalid ID format: must be a 24 character HEX string.` | Invalid `:id` |
| `404` | `There is no such user with that ID.` | No such user, checked before `suspended` |
| `400` | `suspended must be true or false.` | `suspended` is missing or not a boolean (e.g. `"true"` or `1`) |
| `409` | `The superuser's account can't be suspended.` | The user is the superuser |

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
