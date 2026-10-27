# E-mail setup

The API e-mails confirmation codes over SMTP (`src/helpers/mail.ts`, texts in `src/constants/emails.ts`). Production uses [Brevo](https://www.brevo.com)'s SMTP relay, whose free plan sends 300 e-mails a day.

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

## Registration

An account is only created once its e-mail address is confirmed. Until then the details wait in the `pendingregistrations` collection for 24 hours, with the password already hashed.

| Request | Body | Answers |
| --- | --- | --- |
| `POST /auth/register` | `{"username", "email", "password"}` | `202`: a 6 digit code was mailed, valid for 15 minutes. `400`/`409` for the same reasons as before (rules, address or username taken). `429` within a minute of the last code for that address. `503` when the mail couldn't be sent. Registering again after a minute replaces the waiting registration and its code |
| `POST /auth/register/verify` | `{"email", "code"}` | `201`: the account exists and the response logs it in (`VB-AUTH` cookie). `400` for a wrong, expired or used code; after 5 wrong tries the code stops working and a new one is needed. `409` when the address or username was taken meanwhile |
| `POST /auth/register/resend` | `{"email"}` | `200` with the same message whether or not a registration is waiting, so it doesn't reveal addresses; a waiting registration gets a new code, and the old one stops working. `429` within a minute of the last code, `503` when the mail couldn't be sent |

Spaces in the code are ignored. Every `429` has a `Retry-After` header; the cooldown's also has `retryAfter` (seconds) in the body. Accounts made with GitHub count as confirmed, since GitHub only gives verified addresses. `GET /user` tells the frontend with `emailVerified`, which is `false` for accounts from before this.

Through an API client:

```shell
curl -X POST "$API/auth/register" -H 'Content-Type: application/json' \
    -d '{"username": "alice", "email": "alice@example.com", "password": "<password>"}'
curl -X POST "$API/auth/register/verify" -H 'Content-Type: application/json' -c cookies.txt \
    -d '{"email": "alice@example.com", "code": "123456"}'
```

## Password reset

A forgotten password is reset with a code mailed to the account's address. It also works for accounts made with GitHub, giving them a password, since the code proves the address is theirs.

| Request | Body | Answers |
| --- | --- | --- |
| `POST /auth/password-reset` | `{"email"}` | Always the same `200`, so it doesn't reveal which addresses have accounts. An account gets a 6 digit code valid for 30 minutes, at most one a minute. A failed send is only logged. `400` without an e-mail |
| `POST /auth/password-reset/confirm` | `{"email", "code", "newPassword"}` | `200`: the new password is set, every session ends (log in again), and the code is used up. `400` for missing fields, a password breaking the [rules](../README.md#account-rules) (doesn't use up a try), or a wrong, expired or used code; after 5 wrong tries the code stops working and a new one is needed. A successful reset also marks the address confirmed (`emailVerified`) |

The code is stored on the user (`authentication.passwordReset`, never returned by the API) as an HMAC with its expiry and tries.

## E-mail change

The new address is confirmed before it replaces the old one, so a typo or someone else's address can't take over the account's mail.

| Request | Body | Answers |
| --- | --- | --- |
| `PATCH /user/email` (logged in) | `{"email", "password"}` | `202`: a 6 digit code was mailed to the **new** address, valid for 15 minutes; the account keeps its address meanwhile and `GET /user` shows the new one as `pendingEmail`. `200` and no code for the current address. `400`/`403`/`409` as before (format, domain checks, password, superuser, address taken). `429` within a minute of the last code, `503` when the mail couldn't be sent. Asking again after a minute replaces the waiting address |
| `POST /user/email/confirm` (logged in) | `{"code"}` | `200`: the address is changed and confirmed (`emailVerified`), and the old address gets a notice. `400` for a missing, wrong, expired or used code; after 5 wrong tries the code stops working. `409` (or `403` for `SUPERUSER_EMAIL`) when the address was taken meanwhile, which also drops the waiting change |

The waiting change is stored on the user (`authentication.emailChange`, never returned besides `pendingEmail`).

## Domain checks

`POST /auth/register` and `PATCH /user/email` refuse addresses that can't or shouldn't get the code (`src/helpers/emailDomain.ts`), with `400`:

- **Disposable (temp-mail) domains**, from the community-maintained [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) list (CC0, via the `disposable-email-domains-js` package; `yarn upgrade disposable-email-domains-js` pulls the latest list). Subdomains of a listed domain count too. The list only takes domains with proof that they hand out throwaway addresses, so forwarding services like Apple's Hide My Email aren't on it.
- **Domains that can't receive mail**: no MX record and no A/AAAA address (RFC 5321), a lone null MX (RFC 7505), or a domain that doesn't exist. Custom domains with a working mail server pass. When DNS times out or fails, the address is let through rather than blocking a real user.
- **Reserved test domains** (`.test`, `.example`, `.invalid`, `.localhost`) in production. Outside production they're accepted without a lookup, for the unit tests.

Paid checking services aren't used, since they'd get every user's address; the code itself proves the inbox works.

## Limits

- One code per address per minute (stored with the code, so it holds across restarts). `POST /auth/password-reset` still answers `200` within the minute, but doesn't send another code.
- 10 sent codes per client IP per hour, shared by registration, password reset and e-mail change; requests answered with an error don't count. Over it: `429`.
- Wrong codes count like failed password checks: 10 per address (per account for `POST /user/email/confirm`) and 100 per client IP per 15 minutes, then `429`.
- Each code takes 5 tries at most and is stored only as an HMAC (with `CRYPTO_SECRET_KEY`).
