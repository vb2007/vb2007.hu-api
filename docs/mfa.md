# Multi-factor login (MFA)

MFA is optional and off for every account until its owner turns it on. With a method on, a correct password (`POST /auth/login`) or GitHub login no longer starts a session: it starts a short **challenge** that a second step has to pass. Accounts with no method on log in exactly as before, with the same answers and cookies.

There are two methods so far. With e-mail MFA the second step is a 6 digit code or a link mailed to the account's address; an account with a [passkey](#passkeys-as-a-second-factor) can answer it with one instead. The challenge, its endpoints and limits are shared, and each further method only adds an entry to the registry in `src/helpers/mfa.ts` (`mfaMethods`): the fields it needs (`fields`), the paths it stores, which turning it off or an admin reset unsets (`storedPaths`), the paths only an admin reset clears, such as mail counts (`resetPaths`, optional), the database filter that matches an account with it on (`onFilter`, which a backup method leaves out), whether it's on for an account (`isOn`), whether a `POST /auth/mfa/verify` body has what it checks (`isWellFormed`, checked before a try is used) how it checks a try (`verify`) and, optionally, the error a failed try answers (`invalidError`). A method marked `backup` (passkeys) never starts a challenge on its own: `mfaMethodsOn` lists it only next to a method that isn't a backup, and `mfaOnFilter`, which gates starting and reading a challenge, is built only from the methods that aren't.

## The challenge

- A challenge lives in `authentication.mfaChallenge` (`select: false`): only a hash of its secret, its expiry, the number of tries used and, for a GitHub login, the GitHub account to refresh once it's passed. E-mail MFA adds the hashes of the mailed code and link.
- The browser holds the secret in an `HttpOnly` cookie `__Host-VB-MFA` (`Path=/`, `Secure`, `SameSite=Lax`) as `<userId>.<secret>`.
- It's valid for 10 minutes (`MFA_CHALLENGE_MINUTES` in `src/constants/limits.ts`) and 5 tries (`MFA_CHALLENGE_ATTEMPTS`), shared by every code and link. After the 5th wrong try it's removed, and the user has to log in again.
- An account has at most one challenge. Logging in again, from any browser, replaces a waiting one (a [passkey login](./passkeys.md#post-authpasskey) removes it): codes and links mailed for the old one stop working and its cookie answers `403`. The [mail cooldown](#limits) belongs to the account, not the challenge, so a new login doesn't reset it.
- A challenge is removed by `POST /auth/logout` from the browser holding it, by any logout of the account's live session (`POST /auth/logout` with its `__Host-VB-AUTH` cookie, or the superuser's [`POST /admin/users/:id/logout`](./admin-endpoints.md#post-adminusersidlogout)), by a password change, set or reset, an e-mail address change, a suspension, by turning e-mail MFA off, and by the superuser's [MFA reset](#lost-second-factor).
- A challenge never ends or changes the account's live session: that session stays until the second step passes and replaces it, as any login does.
- Passing it starts the session the same way `POST /auth/login` does (`__Host-VB-AUTH`), clears the `__Host-VB-MFA` cookie and removes the challenge. Only a password login also sets the `VB-DEVICE` cookie; a GitHub login refreshes `githubLogin` and the GitHub confirmation time (used by [reauth](#managing-e-mail-mfa)) only at this point.

## Logging in

A `202` from `POST /auth/login` tells the client the password was right, before the second step. That's how MFA works everywhere; the rate limits on failed logins still apply to finding it.

| Endpoint | Body | Answers |
| --- | --- | --- |
| `POST /auth/login` | `{"email", "password"}` | Without MFA: `200` as before. With a method on: `202` `{"mfaRequired": true, "methods": ["email"]}` with the `__Host-VB-MFA` cookie and no session. `methods` lists only the methods that are on, in the order `email`, `totp`, `passkey`, `recovery` as they get added. Wrong credentials, a suspended account and the rate limits answer as before, before any challenge starts |
| `GET /auth/github/callback` | | With a method on, the GitHub login redirects to `<BASE_SITE_URL>/login?mfa=required` with the `__Host-VB-MFA` cookie instead of starting a session |
| `GET /auth/mfa` | | `200` `{"methods": [...]}`, so the frontend can get the list back after the GitHub redirect. The list is never empty: a challenge only starts, and only counts as live, while at least one method is on |
| `POST /auth/mfa/email` | | `202` `{"message"}`: a new code and link were mailed to the account's address, replacing any sent before for this challenge. `400` when e-mail MFA isn't on. `429` within a minute of the last code (also across logins), with `reason: "resendCooldown"`, `retryAfter` and `Retry-After`, or over the [10 a day](#limits) with `reason: "mfaEmailLimit"`. `503` when the mail couldn't be sent, which keeps the earlier code and link; with `reason: "mailBudget"` (and `retryAfter`) when the [daily mail limit](./email-setup.md#limits) is used up. Counts against the 10 mails per client IP an hour |
| `POST /auth/mfa/passkey/options` | | `200` with WebAuthn request options for this account's passkeys, see [passkeys as a second factor](#passkeys-as-a-second-factor). `400` when `passkey` isn't among the methods on (no passkey, or no other method on). Counts against the passkey options' 30 requests per client IP a minute |
| `POST /auth/mfa/verify` | `{"method": "email", "code"}` or `{"method": "passkey", "response"}` | `200` `{"message": "Login successful with user <username>."}` with the session cookie, the same as `POST /auth/login` answers without MFA. `400` for a missing `method`, a method that isn't on, a missing `code`, or a `response` that isn't an object (none uses a try). `400` `{"error": "The code is wrong, expired or already used: check it or request a new one."}` for a wrong code, or `400` `{"error": "The passkey couldn't be verified: try again or log in another way."}` for a passkey that doesn't verify, either of which uses a try |
| `POST /auth/mfa/verify-link` | `{"token"}` | The same as `/auth/mfa/verify` with the link's token instead of a code: `200` and the session, `400` for a missing token, or `400` with `The login link is wrong, …` for a wrong one, using a try |

All five `/auth/mfa` endpoints need the `__Host-VB-MFA` cookie of a live challenge, and answer `403` `{"error": "The login's second step expired, used up its tries or was never started: log in again."}` without it, after its 10 minutes or 5 tries, after a newer login, once the account is suspended or once no method is on any more (an [admin reset](#lost-second-factor) racing a login). That answer also clears the cookie.

The e-mail's link never points at the API: it's `<BASE_SITE_URL>/login/mfa#token=<secret>`, with no account id in it, since the browser's cookie already says whose login it is. The frontend reads the token from the fragment (which never reaches a server) and sends it to `POST /auth/mfa/verify-link`. The link's hash is tied to the challenge, so it only works together with the same browser's `__Host-VB-MFA` cookie: a link opened in another browser, or forwarded, fails.

## Limits

- 5 tries per challenge, shared by codes, links and passkeys.
- At most 20 wrong codes, links and passkeys a day per account (`CODE_FAILURES_PER_DAY`), stored in `authentication.mfaFailures` like the [password reset and e-mail change ones](./email-setup.md#limits), so new logins and restarts don't reset it. Over it, `/auth/mfa/verify` and `/auth/mfa/verify-link` answer `429` `{"error": "Too many failed attempts: try again later.", "retryAfter"}` with a `Retry-After` header without using a try. The superuser clears it with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) (`mfaCodeFailures`).
- Wrong codes, links and passkeys count against the 100 rejected codes per client IP per 15 minutes of `codeChecksPerIp`.
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

## Passkeys as a second factor

An account's [passkeys](./passkeys.md) can answer the second step, with nothing to turn on, but they never ask for one on their own.

- `passkey` is listed in `methods`, and accepted by `POST /auth/mfa/verify`, only while another method that isn't a backup (`email`, later `totp`) is on and the account has at least one passkey. The registry entry is marked `backup`, like recovery codes.
- **A passkey alone turns no challenge on.** A password or GitHub login of an account with passkeys and no other method starts a session at once (`200`), unchanged by this feature. Turning e-mail MFA off, or an admin MFA reset, leaves only the passkeys, so the next login is a plain one again: a user who lost the passkey device isn't locked out after a reset.
- The entry stores nothing of its own (`storedPaths` is empty), so turning another method off or an admin MFA reset never deletes passkeys. Deleting the last passkey ([`DELETE /user/passkeys/:id`](./passkeys.md#delete-userpasskeysid)) drops `passkey` from `methods`.
- A [passkey login](./passkeys.md#post-authpasskey) (`POST /auth/passkey`) still skips MFA, since it's already two factors.

The second step:

1. `POST /auth/mfa/passkey/options` (with the `__Host-VB-MFA` cookie, no body) answers `200` with `PublicKeyCredentialRequestOptionsJSON`: user verification required and `allowCredentials` listing the account's passkeys. It sets no cookie: the WebAuthn challenge is stored in the `passkeychallenges` collection under a hash of the MFA challenge, so it's bound to this account and this login, and a newer login or a new options request replaces it. It's valid for 5 minutes, within the MFA challenge's 10.
2. The frontend passes the options to `navigator.credentials.get()` (or `startAuthentication()` of `@simplewebauthn/browser`) and sends the result's `toJSON()` as `{"method": "passkey", "response"}` to `POST /auth/mfa/verify`.
3. That uses a try and the WebAuthn challenge, whether the passkey verifies or not. It checks the assertion against this account's passkeys only (another account's is refused), the user handle when the authenticator sends one, the origin and RP ID, user verification, the signature and the counter. The new counter and `lastUsedAt` are stored only while the MFA challenge is still live, with the same counter check as [`POST /auth/passkey`](./passkeys.md#post-authpasskey). A passkey that doesn't verify counts like a wrong code. A second assertion for the same options is refused: request new options.

## Lost second factor

A user who can't pass the second step any more (lost access to the mailbox, a lost device) asks the superuser, who turns off every method with [`DELETE /admin/users/:id/mfa`](./admin-endpoints.md#delete-adminusersidmfa). That also ends the user's session and clears the MFA counters, and the user then logs in with only the password (or GitHub) and can turn MFA on again. Passkeys aren't touched: no method may list a path at or under `authentication.passkeys`, `authentication` itself or the challenge in its `storedPaths` or `resetPaths`, which `src/tests/mfaRegistry.test.ts` checks. A superuser who lost their own second factor clears the MFA fields in the database directly (see the [reset](./admin-endpoints.md#delete-adminusersidmfa)).

## Account status

`GET /user` and the superuser's [`GET /admin/users/:id`](./admin-endpoints.md#get-adminusersid) have an `mfa` object, with one field per method:

```json
{ "mfa": { "email": true } }
```
