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

## Limits

- One code per address per minute (stored with the code, so it holds across restarts).
- 10 sent codes per client IP per hour; requests answered with an error don't count. Over it: `429`.
- Wrong codes count like failed password checks: 10 per address and 100 per client IP per 15 minutes, then `429`.
- Each code takes 5 tries at most and is stored only as an HMAC (with `CRYPTO_SECRET_KEY`).
