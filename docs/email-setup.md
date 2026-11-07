# E-mail setup

The API e-mails confirmation codes over SMTP (`src/helpers/mail.ts`, texts in `src/constants/emails.ts`). Production uses [Brevo](https://www.brevo.com)'s SMTP relay on its Free plan, which sends 300 e-mails a day, see [Brevo's quota](#brevos-quota).

## Brevo

1. **Senders, Domains & Dedicated IPs → Domains:** add `vb2007.hu` and add the DNS records Brevo shows (a `brevo-code` TXT, DKIM and DMARC), so mail from `noreply@vb2007.hu` isn't marked as spam. A single verified sender address also works, but an authenticated domain delivers better.
2. **SMTP & API → SMTP:** generate an SMTP key. The page also shows the SMTP server, port and login.
3. Fill in the [mail variables](./dotenv-setup.md#mail-variables) in `.env` and restart the API:

```shell
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<login from the SMTP page>
SMTP_PASSWORD=<SMTP key>
MAIL_FROM="vb2007.hu <noreply@vb2007.hu>"
```

Without `SMTP_HOST` and `MAIL_FROM` nothing is sent: the API logs `E-mail not sent` and, outside production, prints the mail with its code, which is enough for local development. Addresses on reserved test domains (`.test`, `.example`, `.invalid`, `.localhost`) are never mailed, so the unit tests don't use the daily quota; they write a known code's hash into the database instead.

### Brevo's quota

Checked on 2026-11-07 in the Brevo dashboard, whose "Campaign usage and plan" popup shows the account on the Free plan with 300 e-mails left for the day (it points to the Transactional pages for transactional usage), and on the FAQ page itself ([FAQ: limits of the Free plan](https://help.brevo.com/hc/en-us/articles/208580669)).

- **Daily limit:** 300 sends a day, and unused sends don't roll over. The FAQ's retry queue for transactional mail over the limit (below) implies that transactional mail counts towards it. `MAIL_DAILY_LIMIT`'s default of `250` fits it, with the restart and day boundary caveats in [Limits](#limits).
- **Over the limit:** per the FAQ, up to 1,000 more transactional e-mails wait in a retry queue and any beyond that aren't delivered. Users report that queued mail goes out on the following days ([community thread](https://community.brevo.com/t/how-do-i-delete-my-email-queue/2142)), where it would use up those days' quota, and its codes (valid 15 minutes, 30 for password reset and its link) have expired by the time it arrives. What the SMTP relay answers over the limit isn't documented and no day has reached it yet, so the relay may accept a mail (which the API counts and answers as sent) that arrives late or never. The REST API's general errors include `402` `not_enough_credits` ([API errors](https://developers.brevo.com/docs/how-it-works)), but they aren't documented for the daily cap, and this API doesn't use the REST API. Nothing found says the account gets suspended.
- **Reset:** "every day"; the popup shows the date but no time. It may be midnight Europe/Budapest (not confirmed), which is 23:00 UTC in winter and 22:00 UTC in summer, so a Brevo day would overlap the API's previous UTC day by 1–2 hours (see [Limits](#limits)).
- **Other caps:** no hourly or per-second sending cap is documented for the Free plan. The [rate limits](https://developers.brevo.com/docs/api-limits) page covers the REST API (`POST /v3/smtp/email`: 1,000 requests a second, then `429`) and doesn't mention the SMTP relay.

Cloudflare (zone `vb2007.hu` on the Free plan, checked on 2026-11-07) has two custom rules: one blocks known AI bots by user agent on every path except `/robots.txt`, the other (a skip for Firefox Sync) is disabled. Its only rate-limiting rule, the Free plan's single slot, blocks a client IP for 10 seconds after more than 5 requests in 10 seconds that Cloudflare flags as carrying a leaked password, whatever the path. An active response rule, "Cloudflare Managed Response Firewall Default", runs on all incoming requests, and the managed rules card offers an upgrade. No Cloudflare rule targets `/auth/register*`, `/auth/password-reset*` or `/user/email*`, only the path-independent rules above apply to them, so the API's own [limits](#limits) are what bound mail sends.

## Registration

An account is only created once its e-mail address is confirmed. Until then only the address and its code wait in the `pendingregistrations` collection for 24 hours. The username and password are sent again with the code, so only whoever confirms the address sets the password, even if someone else registered it meanwhile.

| Request | Body | Answers |
| --- | --- | --- |
| `POST /auth/register` | `{"username", "email", "password"}` | `202`: a 6 digit code was mailed, valid for 15 minutes. An address that already has an account gets the same `202` and code, so it doesn't reveal which addresses have accounts; the conflict only shows at verify. `400` for the same reasons as before (rules, address, domain checks), `409` when the username is taken. `429` within a minute of the last code for that address. `503` when the mail couldn't be sent, which keeps any earlier waiting registration and its code, and allows a retry right away. Registering again after a minute only replaces the code |
| `POST /auth/register/verify` | `{"email", "code", "username", "password"}` | `201`: the account exists with this username and password, and the response logs it in (`__Host-VB-AUTH` cookie). `400` for missing fields or a username or password breaking the [rules](../README.md#account-rules) (doesn't use up a try), or a wrong, expired or used code; after 5 wrong tries the code stops working and a new one is needed. `409` when the username is taken (the registration is kept, so the code still works with another name, one try spent) or the address already has an account (the registration is discarded) |
| `POST /auth/register/resend` | `{"email"}` | The same `200` for every address (or `429` over the mail limit), answered before the address is looked up, so neither it nor its timing reveals which addresses have a waiting registration. Afterwards a waiting registration gets a new code and the old one stops working, at most one code a minute: within the minute nothing is sent, so the message tells the user to use the latest code they got. A failed send is only logged and keeps the old code working, so a retry works right away; a suspended account's address gets no mail. Once the [daily limit](#limits) refuses registration mail, every address gets the same `503` instead (checked right after the `400` for a missing `email`) |
| `GET /auth/username-available?username=…` | None | `200 {"available": true\|false}`, with the same rule as `POST /auth/register` (see [account rules](../README.md#account-rules)). Waiting registrations don't hold a name, so it can still be taken before the code is confirmed; verify then answers `409`. `400` outside 2 to 16 characters. `429` after 30 checks per client IP per minute. There is no e-mail variant, since it would reveal which addresses have accounts |

Spaces in the code are ignored. Accounts made with GitHub count as confirmed, since GitHub only gives verified addresses. `GET /user` tells the frontend with `emailVerified`, which is `false` for accounts from before this.

Through an API client:

```shell
curl -X POST "$API/auth/register" -H 'Content-Type: application/json' \
    -d '{"username": "alice", "email": "alice@example.com", "password": "<password>"}'
curl -X POST "$API/auth/register/verify" -H 'Content-Type: application/json' -c cookies.txt \
    -d '{"email": "alice@example.com", "code": "123456", "username": "alice", "password": "<password>"}'
```

## Password reset

A forgotten password is reset with a code or a link mailed to the account's address. It also works for accounts made with GitHub, giving them a password, since the mail proves the address is theirs.

| Request | Body | Answers |
| --- | --- | --- |
| `POST /auth/password-reset` | `{"email"}` | Always the same `200` (or `429` over the mail limit), answered before anything is stored or mailed, so neither it nor its timing reveals which addresses have accounts. An account gets a mail with a 6 digit code and a link (`<BASE_SITE_URL>/reset-password#token=<token>`), both valid for 30 minutes, at most one mail a minute. A newer mail replaces the code, but each mail's link keeps working until it expires or the code and links are voided (see below), so requesting resets for someone else's address can't void the link they got. A failed send is only logged, keeps any earlier code working and doesn't add its link; a failed store is only logged too, and either way the client still gets the `200`. `400` without an e-mail |
| `POST /auth/password-reset/confirm` | `{"email", "code", "newPassword"}` | `200`: the new password is set, every session ends (log in again), the code and every link are used up, and the account's address gets a notice that the password was changed (a failed send is only logged). `400` for missing fields, a password breaking the [rules](../README.md#account-rules) (doesn't use up a try), or a wrong, expired or used code; after 5 wrong tries the code stops working and a new one is needed. A successful reset also marks the address confirmed (`emailVerified`) |
| `POST /auth/password-reset/confirm-link` | `{"token", "newPassword"}` | The same `200` as with the code, which it also uses up, with every link. `token` is the part of the link after `#token=`: the fragment never reaches a server, so it stays out of logs and `Referer` headers. `400` for missing or non-string fields, a password breaking the [rules](../README.md#account-rules) (doesn't use up the link), or a malformed, wrong, expired or used token. Only one of parallel requests with the same link succeeds |

The code is stored on the user (`authentication.passwordReset`, never returned by the API) as an HMAC with its expiry and tries. The token is `<user id>.<secret>` with 32 random bytes as the secret, so it has no tries counter; the links are stored next to the code (`authentication.passwordResetLinks`, never returned either) as HMACs of the secret with their expiry, dropping expired ones on each new mail and keeping at most 30 (one a minute for 30 minutes). The code and every link are voided by a successful reset (with either), a confirmed e-mail change (`POST /user/email/confirm`; a waiting `PATCH /user/email` doesn't), and setting or changing the password (`POST /user/password`, `PATCH /user/password`). Voiding the code also lifts the one-a-minute cooldown, so a new reset can be requested right away.

## E-mail change

The new address is confirmed before it replaces the old one, so a typo or someone else's address can't take over the account's mail.

| Request | Body | Answers |
| --- | --- | --- |
| `PATCH /user/email` (logged in) | `{"email", "password"}` | `202`: a 6 digit code was mailed to the **new** address, valid for 15 minutes; the account keeps its address meanwhile and `GET /user` shows the new one as `pendingEmail`. `200` and no code for the current address. Another account's address and `SUPERUSER_EMAIL` get the same `202` and code, so it doesn't reveal which addresses have accounts; the conflict only shows at confirm. `400`/`403` as before (format, domain checks, password, the superuser changing its own), `409` when the account has no password. `429` within a minute of the last code, `503` when the mail couldn't be sent, which keeps any earlier waiting address and its code (or none), and allows a retry right away. Asking again after a minute replaces the waiting address |
| `POST /user/email/confirm` (logged in) | `{"code"}` | `200`: the address is changed and confirmed (`emailVerified`), and the old address gets a notice. `400` for a missing, wrong, expired or used code; after 5 wrong tries the code stops working. `409` (or `403` for `SUPERUSER_EMAIL`) when another account has the address, which also drops the waiting change |

The waiting change is stored on the user (`authentication.emailChange`, never returned besides `pendingEmail`).

## Domain checks

`POST /auth/register` and `PATCH /user/email` refuse addresses that can't or shouldn't get the code (`src/helpers/emailDomain.ts`), with `400`:

- **Disposable (temp-mail) domains**, from the community-maintained [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) list (CC0, via the `disposable-email-domains-js` package; `yarn upgrade disposable-email-domains-js` pulls the latest list). Subdomains of a listed domain count too. The list only takes domains with proof that they hand out throwaway addresses, so forwarding services like Apple's Hide My Email aren't on it.
- **Domains that can't receive mail**: no MX record and no A/AAAA address (RFC 5321), a lone null MX (RFC 7505), or a domain that doesn't exist. Custom domains with a working mail server pass. When DNS times out or fails, the address is let through rather than blocking a real user.
- **Reserved test domains** (`.test`, `.example`, `.invalid`, `.localhost`) in production. Outside production they're accepted without a lookup, for the unit tests.

Paid checking services aren't used, since they'd get every user's address; the code itself proves the inbox works.

## Limits

- One code per address per minute (stored with the code, so it holds across restarts). `POST /auth/password-reset` and `POST /auth/register/resend` still answer the same `200` within the minute, but don't send another code (or link), so their messages tell the user to use the latest code they got.
- A send gives up after 10 s without a connection or greeting, or after 20 s without any reply to an SMTP command, so a stuck or unreachable SMTP host doesn't hang a request for minutes (a slow server that keeps answering can still take longer).
- A failed send puts back the earlier code, or drops the new one when nothing was waiting (see the endpoints above). If SMTP accepted the mail but its reply was lost (the connection dropped or timed out after sending it), the API treats it as failed too: registration and e-mail change answer `503`, password reset and the registration resend still answer `200` and only log it. The mail that may arrive then carries a code that doesn't work, but the cooldown is reset, so asking again works right away.
- 10 sent codes per client IP per hour, shared by registration, its resend, password reset and e-mail change; requests answered with an error don't count. Password reset and the resend answer `200` before they know whether a code goes out, so each of their requests counts, also one for an address without an account or waiting registration, within the minute or whose send fails. Over it: `429`.
- At most `MAIL_DAILY_LIMIT` e-mails (default `250`, 50 below [Brevo's 300](#brevos-quota)) are sent per UTC day, counted in `sendMail` for every send that doesn't fail, whatever its type. Mail that isn't sent (SMTP not set, reserved test domains) and every failed send (SMTP errors, including a mail SMTP accepted but whose reply was lost) doesn't count. A fifth of the limit (rounded up, `50` of `250`) is kept for mail to existing accounts (password reset, e-mail change, the password-changed and e-mail-changed notices): registration codes and their resends stop once the day's count reaches the rest (`200`) and answer `503`, while mail to existing accounts can use the whole limit and also counts against the registration share. At 80 % the API logs a warning once a day. The first registration mail refused at its share logs a `Daily e-mail limit for registration used up` error, and the first mail refused at the limit a `Daily e-mail limit used up` error, each once a day, whether the mail or a resend's check (below) was refused first; the handler (or, for password reset and the resend, the background send) of every refused send also logs the thrown error. `POST /auth/register/resend` checks the registration share and the limit right after the `400` for a missing `email`, before looking up the address, and answers `503` for every address once either is used up, without sending, looking it up or logging more than that daily error, so the answer doesn't reveal which addresses have a waiting registration; while SMTP isn't set the check never refuses, since nothing is sent then. Over the limit nothing is sent: registration and e-mail change answer `503`, password reset and a resend that passed the check (the limit ran out in between) still answer `200` and log the failed send. The count lives in memory and starts again from 0 at UTC midnight and on every restart (deploys included), so a day with a restart can send up to 2× `MAIL_DAILY_LIMIT` (more with more restarts). Brevo doesn't say when its day starts, so if it isn't UTC midnight, one Brevo day can also span two API days, again up to 2×.
- Wrong codes count like failed password checks: 10 per address (per account for `POST /user/email/confirm`) and 100 per client IP per 15 minutes, then `429`. These counters live in memory and reset when the API restarts. The ones per client IP and per account send `RateLimit` and `RateLimit-Policy` headers; the one per address doesn't, since its count includes other clients' wrong codes for the address.
- On top of that, at most 20 wrong codes each for an account's password reset, a waiting registration and an account's e-mail change (whichever address it waits for) within 24 hours of the first one. The count is stored beside the code, so new codes, failed sends and restarts don't reset it. A successful password reset ends it, an e-mail change (confirmed or refused) doesn't, and a waiting registration's count goes with the registration, which expires 24 hours after its last `POST /auth/register`. Over it, `POST /auth/register/verify` and `POST /user/email/confirm` answer `429`, while `POST /auth/password-reset/confirm` answers like a wrong code (`400` `invalidCode`, counted by the 15-minute limits), so it doesn't reveal which addresses have accounts.
- Only a code that was checked and rejected (`invalidCode`) counts. A missing or non-string code or a missing or rule-breaking new password answers `400` without counting.
- `POST /auth/password-reset` isn't limited by the wrong-code counters and keeps mailing codes, but over a limit even the right code is refused (`429`, or a wrong-code `400` for password reset) until the window ends. So anyone who knows an address can block its password reset by code and its registration for about a day with 20 wrong codes from any IPs; blocking an account's e-mail change takes that account's session. The link in the same password reset mail isn't gated by these counters, so the owner can still reset the password with it. The `429` from `POST /auth/register/verify` only reveals that a registration is waiting for the address. Logging in with the password doesn't use these counters.
- `POST /auth/password-reset/confirm-link` only counts rejected tokens per client IP: 100 per 15 minutes (an IPv6 client counts as its /56), then `429`, even for a valid link, which isn't used up and still works from another network. It has no limit per address or account, since its secret can't be guessed and such a limit would let anyone block the owner again.
- Each code takes 5 tries at most and is stored only as an HMAC (with `CRYPTO_SECRET_KEY`).

Every `429` has `retryAfter` (seconds) in the body and a `Retry-After` header, which is exposed to the CORS origins.
