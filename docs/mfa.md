# Multi-factor login (MFA)

MFA is optional and off for every account until its owner turns it on. With a method on, a correct password (`POST /auth/login`) or GitHub login no longer starts a session: it starts a short **challenge** that a second step has to pass. Accounts with no method on log in exactly as before, with the same answers and cookies.

E-mail MFA is the first method: the second step is a 6 digit code or a link mailed to the account's address. The challenge, its endpoints and limits are shared, and each further method only adds an entry to the registry in `src/helpers/mfa.ts` (`mfaMethods`): the fields it needs (`fields`), the paths it stores, which turning it off or an admin reset unsets (`storedPaths`), whether it's on for an account (`isOn`), whether a `POST /auth/mfa/verify` body has what it checks (`isWellFormed`, checked before a try is used) and how it checks a try (`verify`). A method marked `backup` ([recovery codes](#recovery-codes)) never starts a challenge on its own: `mfaMethodsOn` lists it only next to a method that isn't a backup.

## The challenge

- A challenge lives in `authentication.mfaChallenge` (`select: false`): only a hash of its secret, its expiry, the number of tries used and, for a GitHub login, the GitHub account to refresh once it's passed. E-mail MFA adds the hashes of the mailed code and link.
- The browser holds the secret in an `HttpOnly` cookie `__Host-VB-MFA` (`Path=/`, `Secure`, `SameSite=Lax`) as `<userId>.<secret>`.
- It's valid for 10 minutes (`MFA_CHALLENGE_MINUTES` in `src/constants/limits.ts`) and 5 tries (`MFA_CHALLENGE_ATTEMPTS`), shared by every code and link. After the 5th wrong try it's removed, and the user has to log in again.
- An account has at most one challenge. Logging in again, from any browser, replaces a waiting one: codes and links mailed for the old one stop working and its cookie answers `403`. The [mail cooldown](#limits) belongs to the account, not the challenge, so a new login doesn't reset it.
- A challenge is removed by `POST /auth/logout` from the browser holding it, by any logout of the account's live session (`POST /auth/logout` with its `__Host-VB-AUTH` cookie, or the superuser's [`POST /admin/users/:id/logout`](./admin-endpoints.md#post-adminusersidlogout)), by a password change, set or reset, an e-mail address change, a suspension, and by turning e-mail MFA off.
- A challenge never ends or changes the account's live session: that session stays until the second step passes and replaces it, as any login does.
- Passing it starts the session the same way `POST /auth/login` does (`__Host-VB-AUTH`), clears the `__Host-VB-MFA` cookie and removes the challenge. Only a password login also sets the `VB-DEVICE` cookie; a GitHub login refreshes `githubLogin` and the GitHub confirmation time (used by [reauth](#managing-e-mail-mfa)) only at this point.

## Logging in

A `202` from `POST /auth/login` tells the client the password was right, before the second step. That's how MFA works everywhere; the rate limits on failed logins still apply to finding it.

| Endpoint | Body | Answers |
| --- | --- | --- |
| `POST /auth/login` | `{"email", "password"}` | Without MFA: `200` as before. With a method on: `202` `{"mfaRequired": true, "methods": ["email", "recovery"]}` with the `__Host-VB-MFA` cookie and no session. `methods` lists only the methods that are on, in the order `email`, `totp`, `passkey`, `recovery` as they get added (`recovery` only next to another method). Wrong credentials, a suspended account and the rate limits answer as before, before any challenge starts |
| `GET /auth/github/callback` | | With a method on, the GitHub login redirects to `<BASE_SITE_URL>/login?mfa=required` with the `__Host-VB-MFA` cookie instead of starting a session |
| `GET /auth/mfa` | | `200` `{"methods": [...]}`, so the frontend can get the list back after the GitHub redirect |
| `POST /auth/mfa/email` | | `202` `{"message"}`: a new code and link were mailed to the account's address, replacing any sent before for this challenge. `400` when e-mail MFA isn't on. `429` within a minute of the last code (also across logins), with `reason: "resendCooldown"`, `retryAfter` and `Retry-After`, or over the [10 a day](#limits) with `reason: "mfaEmailLimit"`. `503` when the mail couldn't be sent, which keeps the earlier code and link; with `reason: "mailBudget"` (and `retryAfter`) when the [daily mail limit](./email-setup.md#limits) is used up. Counts against the 10 mails per client IP an hour |
| `POST /auth/mfa/verify` | `{"method": "email", "code"}`, or `{"method": "recovery", "code"}` with a [recovery code](#recovery-codes) | `200` `{"message": "Login successful with user <username>."}` with the session cookie, the same as `POST /auth/login` answers without MFA. `400` for a missing `method`, a method that isn't on, or a missing `code` (none uses a try). `400` `{"error": "The code is wrong, expired or already used: check it or request a new one."}` for a wrong code, which uses a try |
| `POST /auth/mfa/verify-link` | `{"token"}` | The same as `/auth/mfa/verify` with the link's token instead of a code: `200` and the session, `400` for a missing token, or `400` with `The login link is wrong, …` for a wrong one, using a try |

All four `/auth/mfa` endpoints need the `__Host-VB-MFA` cookie of a live challenge, and answer `403` `{"error": "The login's second step expired, used up its tries or was never started: log in again."}` without it, after its 10 minutes or 5 tries, after a newer login or once the account is suspended. That answer also clears the cookie.

The e-mail's link never points at the API: it's `<BASE_SITE_URL>/login/mfa#token=<secret>`, with no account id in it, since the browser's cookie already says whose login it is. The frontend reads the token from the fragment (which never reaches a server) and sends it to `POST /auth/mfa/verify-link`. The link's hash is tied to the challenge, so it only works together with the same browser's `__Host-VB-MFA` cookie: a link opened in another browser, or forwarded, fails.

## Limits

- 5 tries per challenge, shared by codes, links and recovery codes.
- At most 20 wrong codes, links and recovery codes a day per account (`CODE_FAILURES_PER_DAY`), stored in `authentication.mfaFailures` like the [password reset and e-mail change ones](./email-setup.md#limits), so new logins and restarts don't reset it. Over it, `/auth/mfa/verify` and `/auth/mfa/verify-link` answer `429` `{"error": "Too many failed attempts: try again later.", "retryAfter"}` with a `Retry-After` header without using a try. The superuser clears it with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) (`mfaCodeFailures`).
- Wrong codes and links count against the 100 rejected codes per client IP per 15 minutes of `codeChecksPerIp`.
- One MFA mail a minute per account, kept across logins, and 10 per client IP an hour.
- At most 10 MFA mails a day per account (`MFA_EMAILS_PER_DAY`), counted over 24 hours from the first one and stored in `authentication.mfaEmailSends`, so one account can't use up the site's mail budget. Over it, `POST /auth/mfa/email` answers `429` with `reason: "mfaEmailLimit"`, `retryAfter` and `Retry-After`. A failed send doesn't count. The superuser clears it with `DELETE /admin/rate-limits` (`mfaEmailSends`).
- The mails count against the site's [daily mail limit](./email-setup.md#limits) like the other mail to existing accounts: they only stop once the whole `MAIL_DAILY_LIMIT` is used up. Then `POST /auth/mfa/email` answers `503` with `reason: "mailBudget"` and `retryAfter` (seconds until the next UTC midnight) and keeps the earlier code and link, and e-mail MFA logins can't get a new code until then.

## Managing e-mail MFA

| Endpoint | Body | Answers |
| --- | --- | --- |
| `PUT /user/mfa/email` (logged in) | `{"password"}` | `200` `{"message"}`: e-mail MFA is on, also when it already was. When the account had no [recovery codes](#recovery-codes) left, the answer also has `"recoveryCodes": [...]`, a fresh set shown only this once. `409` when the account's address isn't confirmed (`emailVerified` is `false`): a password reset or an e-mail change confirms it |
| `DELETE /user/mfa/email` (logged in) | `{"password"}` | `200` `{"message"}`: e-mail MFA is off, also when it already was, and a waiting challenge is removed. With no other method on, the recovery codes are removed too |

Both need the user to confirm it's them:

- An account with a password sends it: `400` when it's missing, `403` `{"error": "The provided password is incorrect."}` when it's wrong, counted like the other [password checks](../README.md#account-rules) (10 per account and 100 per client IP per 15 minutes).
- An account without one (made with GitHub) sends no password, but needs a GitHub login or relink in the last 10 minutes (`GITHUB_REAUTH_MINUTES`), else `403` with `Confirm it's you first: log in with GitHub again (or relink it), …`.

`rejectFailedMfaReauth` in `src/helpers/reauth.ts` does this check for every MFA setting. The change itself is only written while the session is still live and the password unchanged, or, without a password, while the GitHub confirmation is still recent (`reauthedSessionFilter`), so a logout, a password change or an expiring confirmation in between makes it answer `403` and change nothing.

## Recovery codes

Recovery codes are the way back in when the second step can't be done, for example with no access to the account's mailbox.

- An account gets 10 single-use codes (`MFA_RECOVERY_CODES`). Each is 10 random base32 characters (`a`–`z`, `2`–`7`), shown as `xxxxx-xxxxx`. Case, spaces and dashes don't matter when one is sent.
- Only HMAC hashes scoped to the account are stored (`authentication.mfaRecoveryCodes`, `select: false`), so the codes are shown only in the answer that makes them.
- They're made when the first method turns on: `PUT /user/mfa/email` answers them in `recoveryCodes` when the account had none left, and later turn-ons answer none.
- At login they answer the second step like any method: `POST /auth/mfa/verify` with `{"method": "recovery", "code"}`. They share the challenge's 5 tries, the 20 wrong tries a day and the per-IP limit with the other codes, and a wrong one answers the same `400`.
- A code that matches is removed in the same write that checks it, so it works once: two parallel logins with one code start one session, and the other gets `400` (or `403` once the challenge is gone). It's used up even if the session then can't start, for example when the challenge expires or the account is suspended in that instant.
- Codes alone never ask for a second step: `recovery` is listed in `methods` only when another method is on and codes are left, and an account with codes but no other method logs in without MFA.
- Turning the last other method off removes the codes, so turning one on again makes a fresh set. The superuser's MFA reset will remove them too.
- A password reset doesn't turn MFA off or remove the codes: it changes only the password, and the next login still needs the second step. With the second step lost, a recovery code or the superuser's MFA reset is the way back in.

| Endpoint | Body | Answers |
| --- | --- | --- |
| `POST /user/mfa/recovery-codes` (logged in) | `{"password"}` | `200` `{"message", "recoveryCodes": [...]}`: 10 new codes, and the earlier ones stop working. `409` `{"error": "Turn on an MFA method first: …"}` when no method is on. Confirming it's you works as for [e-mail MFA](#managing-e-mail-mfa) (`400`, `403`), and the codes are only written while the session is still live and the password unchanged |

For new methods, in `src/helpers/mfaRecovery.ts` and `src/helpers/mfa.ts`:

- `issueMfaRecoveryCodes(userId, reauthed)` makes a fresh set only when the account has none left, in a write limited to `reauthed` (a `reauthedSessionFilter`), and returns the codes to show, or `null` when it made none. A method's turn-on (TOTP's confirm, for example) calls it after its own write and adds `recoveryCodes` to its `200` only when it got codes. `issueMfaRecoveryCodes(userId, reauthed, true)` replaces the set, as `POST /user/mfa/recovery-codes` does.
- `mfaPathsToTurnOff(method, authentication)` gives the paths a method's turn-off unsets: its own `storedPaths`, plus the recovery codes when no other method stays on. `authentication` needs `mfaFields` selected.

## Account status

`GET /user` and the superuser's [`GET /admin/users/:id`](./admin-endpoints.md#get-adminusersid) have an `mfa` object, with one field per method:

```json
{ "mfa": { "email": true, "recoveryCodesLeft": 10 } }
```

`recoveryCodesLeft` is the number of unused [recovery codes](#recovery-codes), `0` without any.
