# Multi-factor login (MFA)

MFA is optional and off for every account until its owner turns it on. With a method on, a correct password (`POST /auth/login`) or GitHub login no longer starts a session: it starts a short **challenge** that a second step has to pass. Accounts with no method on log in exactly as before, with the same answers and cookies.

Two methods are there: [e-mail MFA](#managing-e-mail-mfa), where the second step is a 6 digit code or a link mailed to the account's address, and [TOTP](#totp), a 6 digit code from an authenticator app. The challenge, its endpoints and limits are shared, and each further method only adds an entry to the registry in `src/helpers/mfa.ts` (`mfaMethods`): the fields it needs (`fields`), the paths it stores, which turning it off or an admin reset unsets (`storedPaths`), whether it's on for an account (`isOn`), whether a `POST /auth/mfa/verify` body has what it checks (`isWellFormed`, checked before a try is used) and how it checks a try (`verify`).

## The challenge

- A challenge lives in `authentication.mfaChallenge` (`select: false`): only a hash of its secret, its expiry, the number of tries used and, for a GitHub login, the GitHub account to refresh once it's passed. E-mail MFA adds the hashes of the mailed code and link.
- The browser holds the secret in an `HttpOnly` cookie `__Host-VB-MFA` (`Path=/`, `Secure`, `SameSite=Lax`) as `<userId>.<secret>`.
- It's valid for 10 minutes (`MFA_CHALLENGE_MINUTES` in `src/constants/limits.ts`) and 5 tries (`MFA_CHALLENGE_ATTEMPTS`), shared by every code and link. After the 5th wrong try it's removed, and the user has to log in again.
- An account has at most one challenge. Logging in again, from any browser, replaces a waiting one: codes and links mailed for the old one stop working and its cookie answers `403`. The [mail cooldown](#limits) belongs to the account, not the challenge, so a new login doesn't reset it.
- A challenge is removed by `POST /auth/logout` from the browser holding it, by any logout of the account's live session (`POST /auth/logout` with its `__Host-VB-AUTH` cookie, or the superuser's [`POST /admin/users/:id/logout`](./admin-endpoints.md#post-adminusersidlogout)), by a password change, set or reset, an e-mail address change, a suspension, and by turning e-mail MFA or TOTP off.
- A challenge never ends or changes the account's live session: that session stays until the second step passes and replaces it, as any login does.
- Passing it starts the session the same way `POST /auth/login` does (`__Host-VB-AUTH`), clears the `__Host-VB-MFA` cookie and removes the challenge. Only a password login also sets the `VB-DEVICE` cookie; a GitHub login refreshes `githubLogin` and the GitHub confirmation time (used by [reauth](#managing-e-mail-mfa)) only at this point.

## Logging in

A `202` from `POST /auth/login` tells the client the password was right, before the second step. That's how MFA works everywhere; the rate limits on failed logins still apply to finding it.

| Endpoint | Body | Answers |
| --- | --- | --- |
| `POST /auth/login` | `{"email", "password"}` | Without MFA: `200` as before. With a method on: `202` `{"mfaRequired": true, "methods": ["email"]}` with the `__Host-VB-MFA` cookie and no session. `methods` lists only the methods that are on, in the order `email`, `totp`, `passkey`, `recovery` as they get added. Wrong credentials, a suspended account and the rate limits answer as before, before any challenge starts |
| `GET /auth/github/callback` | | With a method on, the GitHub login redirects to `<BASE_SITE_URL>/login?mfa=required` with the `__Host-VB-MFA` cookie instead of starting a session |
| `GET /auth/mfa` | | `200` `{"methods": [...]}`, so the frontend can get the list back after the GitHub redirect |
| `POST /auth/mfa/email` | | `202` `{"message"}`: a new code and link were mailed to the account's address, replacing any sent before for this challenge. `400` when e-mail MFA isn't on. `429` within a minute of the last code (also across logins), with `reason: "resendCooldown"`, `retryAfter` and `Retry-After`, or over the [10 a day](#limits) with `reason: "mfaEmailLimit"`. `503` when the mail couldn't be sent, which keeps the earlier code and link; with `reason: "mailBudget"` (and `retryAfter`) when the [daily mail limit](./email-setup.md#limits) is used up. Counts against the 10 mails per client IP an hour |
| `POST /auth/mfa/verify` | `{"method": "email", "code"}` or `{"method": "totp", "code"}` | `200` `{"message": "Login successful with user <username>."}` with the session cookie, the same as `POST /auth/login` answers without MFA. `400` for a missing `method`, a method that isn't on, or a missing `code` (none uses a try). `400` `{"error": "The code is wrong, expired or already used: check it or request a new one."}` for a wrong code, which uses a try. A [TOTP](#totp) code that was already used, or is older than the last one used, counts as wrong |
| `POST /auth/mfa/verify-link` | `{"token"}` | The same as `/auth/mfa/verify` with the link's token instead of a code: `200` and the session, `400` for a missing token, or `400` with `The login link is wrong, …` for a wrong one, using a try |

All four `/auth/mfa` endpoints need the `__Host-VB-MFA` cookie of a live challenge, and answer `403` `{"error": "The login's second step expired, used up its tries or was never started: log in again."}` without it, after its 10 minutes or 5 tries, after a newer login or once the account is suspended. That answer also clears the cookie.

The e-mail's link never points at the API: it's `<BASE_SITE_URL>/login/mfa#token=<secret>`, with no account id in it, since the browser's cookie already says whose login it is. The frontend reads the token from the fragment (which never reaches a server) and sends it to `POST /auth/mfa/verify-link`. The link's hash is tied to the challenge, so it only works together with the same browser's `__Host-VB-MFA` cookie: a link opened in another browser, or forwarded, fails.

## Limits

- 5 tries per challenge, shared by codes and links.
- At most 20 wrong codes and links a day per account (`CODE_FAILURES_PER_DAY`), shared with wrong [TOTP setup](#totp) codes and stored in `authentication.mfaFailures` like the [password reset and e-mail change ones](./email-setup.md#limits), so new logins and restarts don't reset it. Over it, `/auth/mfa/verify` and `/auth/mfa/verify-link` answer `429` `{"error": "Too many failed attempts: try again later.", "retryAfter"}` with a `Retry-After` header without using a try. The superuser clears it with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) (`mfaCodeFailures`).
- Wrong codes and links count against the 100 rejected codes per client IP per 15 minutes of `codeChecksPerIp`.
- One MFA mail a minute per account, kept across logins, and 10 per client IP an hour.
- At most 10 MFA mails a day per account (`MFA_EMAILS_PER_DAY`), counted over 24 hours from the first one and stored in `authentication.mfaEmailSends`, so one account can't use up the site's mail budget. Over it, `POST /auth/mfa/email` answers `429` with `reason: "mfaEmailLimit"`, `retryAfter` and `Retry-After`. A failed send doesn't count. The superuser clears it with `DELETE /admin/rate-limits` (`mfaEmailSends`).
- The mails count against the site's [daily mail limit](./email-setup.md#limits) like the other mail to existing accounts: they only stop once the whole `MAIL_DAILY_LIMIT` is used up. Then `POST /auth/mfa/email` answers `503` with `reason: "mailBudget"` and `retryAfter` (seconds until the next UTC midnight) and keeps the earlier code and link, and e-mail MFA logins can't get a new code until then.

## Managing e-mail MFA

| Endpoint | Body | Answers |
| --- | --- | --- |
| `PUT /user/mfa/email` (logged in) | `{"password"}` | `200` `{"message"}`: e-mail MFA is on, also when it already was. `409` when the account's address isn't confirmed (`emailVerified` is `false`): a password reset or an e-mail change confirms it |
| `DELETE /user/mfa/email` (logged in) | `{"password"}` | `200` `{"message"}`: e-mail MFA is off, also when it already was, and a waiting challenge is removed |

Both need the user to confirm it's them:

- An account with a password sends it: `400` when it's missing, `403` `{"error": "The provided password is incorrect."}` when it's wrong, counted like the other [password checks](../README.md#account-rules) (10 per account and 100 per client IP per 15 minutes).
- An account without one (made with GitHub) sends no password, but needs a GitHub login or relink in the last 10 minutes (`GITHUB_REAUTH_MINUTES`), else `403` with `Confirm it's you first: log in with GitHub again (or relink it), …`.

`rejectFailedMfaReauth` in `src/helpers/reauth.ts` does this check for every MFA setting. The change itself is only written while the session is still live and the password unchanged, or, without a password, while the GitHub confirmation is still recent (`reauthedSessionFilter`), so a logout, a password change or an expiring confirmation in between makes it answer `403` and change nothing.

## TOTP

TOTP ([RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)) works with any authenticator app: HMAC-SHA1, 6 digits, a new code every 30 seconds. The API accepts the code of the current 30 seconds and of the ones just before and after, to allow for clock drift. It's in `src/helpers/mfaTotp.ts`, with no extra dependency.

| Endpoint | Body | Answers |
| --- | --- | --- |
| `POST /user/mfa/totp` (logged in) | `{"password"}` | `200` `{"secret", "otpauthUrl"}`: a new secret (20 random bytes, base32 without padding) that waits 10 minutes (`MFA_TOTP_SETUP_MINUTES`) for its first code. `otpauthUrl` is `otpauth://totp/vb2007.hu:<username>?secret=<secret>&issuer=vb2007.hu&algorithm=SHA1&digits=6&period=30`, for a QR code. A new setup replaces a waiting one; with TOTP already on, the working secret stays until the new one is confirmed |
| `POST /user/mfa/totp/confirm` (logged in) | `{"password", "code"}` | `200` `{"message"}`: TOTP is on with the waiting secret, which replaces an earlier one. `400` `{"error": "You must provide the confirmation code."}` without a `code`. `400` `{"error": "The code is wrong, expired or already used: check it or request a new one."}` for a wrong code, and when no setup waits or it expired or used up its 5 tries (`MFA_TOTP_SETUP_ATTEMPTS`): then start a new one |
| `DELETE /user/mfa/totp` (logged in) | `{"password"}` | `200` `{"message"}`: TOTP is off, also when it already was, and a waiting setup and a waiting challenge are removed |

- All three confirm it's the user like [e-mail MFA](#managing-e-mail-mfa) does (`rejectFailedMfaReauth`): the password, or a GitHub login in the last 10 minutes for an account without one, with the same answers. The confirm checks it before using a try. The change is only written while the session is still live and the password unchanged (`reauthedSessionFilter`), else `403`.
- Wrong confirm codes count against the account's 20 wrong MFA codes a day (`authentication.mfaFailures`, `429` over it like `/auth/mfa/verify`), and against `limitAccountCodeChecks`: 10 per account and 100 per client IP per 15 minutes. Wrong passwords count like on the other [password checks](../README.md#account-rules).
- The secret is never returned after `POST /user/mfa/totp`. It's stored encrypted with AES-256-GCM, under a key derived from `CRYPTO_SECRET_KEY` and bound to the account's id, in `authentication.mfaTotpSetup` while it waits and `authentication.mfaTotpSecret` once it's on (both `select: false`). Changing `CRYPTO_SECRET_KEY` makes every TOTP secret unreadable, so TOTP logins fail, as password logins do.
- Each code works once: logging in (and the confirm) stores the code's 30 second step in `authentication.mfaTotpLastStep`, in the same write that checks it's newer than the stored one, so a code that was already used, or is older than the last one used, fails even in parallel requests.
- At login, `POST /auth/mfa/verify` with `{"method": "totp", "code"}` uses the challenge's tries and the daily limit like an e-mail code.

## Account status

`GET /user` and the superuser's [`GET /admin/users/:id`](./admin-endpoints.md#get-adminusersid) have an `mfa` object, with one field per method:

```json
{ "mfa": { "email": true, "totp": false } }
```

`totp` is `true` once a TOTP setup has been confirmed, not while one only waits for its code.
