# Passkeys

Users can add passkeys (WebAuthn credentials) to their account and log in with one, without an e-mail address or password. The API checks the ceremonies with [`@simplewebauthn/server`](https://simplewebauthn.dev/docs/packages/server); the frontend runs `navigator.credentials`.

## Relying party

There are no extra variables: everything comes from `BASE_SITE_URL`.

- The RP ID is its hostname (`vb2007.hu`), and the only accepted origin is its origin (`https://vb2007.hu`). The API doesn't need to run on that host, but the page calling `navigator.credentials` does.
- A passkey is bound to the RP ID it was made for, so changing the hostname in `BASE_SITE_URL` orphans every stored passkey: they stay listed, but none of them can log in any more.
- For local development, `BASE_SITE_URL` has to be the frontend's own origin on `localhost`, e.g. `http://localhost:5173` (RP ID `localhost`, which browsers allow over plain http). An IP address like `127.0.0.1` isn't a valid RP ID, so passkeys don't work with one. The challenge cookies are always `Secure`, which browsers that treat `http://localhost` as secure (Chromium, Firefox) accept there.

Only the `none` attestation is asked for, and the accepted key types are Ed25519 (`-8`), ES256 (`-7`) and RS256 (`-257`). Every ceremony requires user verification (PIN, fingerprint, face).

## Storage

- Passkeys are stored on the user as `authentication.passkeys[]` (all `select: false`): the credential id, the public key (COSE, base64url), the signature counter, the transports the browser reported, the user-given name, `createdAt` and `lastUsedAt`. Deleting the account deletes them with it.
- A credential id belongs to one account only: a unique index on `authentication.passkeys.credentialId` refuses a second account registering the same one.
- The user handle given to the authenticator is the account's id (its 12 bytes, base64url), not the username or e-mail address. A login has to send back the handle of the account that owns the credential.
- Each ceremony's challenge is stored in the `passkeychallenges` collection under the sha256 of a random id (for the [MFA second step](./mfa.md#passkeys-as-a-second-factor), of its MFA challenge instead, with no cookie of its own). That id goes to the browser in an `HttpOnly` cookie (`Path=/`, `Secure`, `SameSite=Lax`, no `Domain`): `__Host-VB-PASSKEY-REG` for a registration and `__Host-VB-PASSKEY-LOGIN` for a login, so starting a login (e.g. in another tab) doesn't end a registration in progress. A challenge is valid for 5 minutes and is used up by the first request that gets as far as checking it, whether the passkey then verifies or not (a request refused earlier, for a bad `name` or a `response` that isn't an object, leaves it); a MongoDB TTL index removes the expired ones. A challenge that belongs to another account or ceremony (another account's registration, or a login challenge sent to `POST /user/passkeys`) is refused without being used up. A registration challenge is bound to the account that asked for it, and a login challenge to no account.

## Managing passkeys

These need a logged-in session (`__Host-VB-AUTH`), else `403` with `You must be logged in to perform this action.`

### Confirming it's the owner

Starting a registration and deleting a passkey need the owner to confirm:

- an account with a password sends it as `{"password": "…"}`: missing, empty or not a string answers `400` (`You must provide your password to change MFA settings.`), a wrong one `403` (`The provided password is incorrect.`). Wrong passwords count against the same per-account and per-IP limits as `DELETE /user` (see the [README](../README.md#account-rules));
- an account without a password (made with GitHub) needs a GitHub login or relink (`POST /auth/github/link`) within the last 10 minutes, else `403` (`Confirm it's you first: …, then change MFA settings within 10 minutes.`).

This is the same check as for the [MFA settings](./mfa.md#managing-e-mail-mfa) (`rejectFailedMfaReauth` in `src/helpers/reauth.ts`). Deleting is only written while the session is still live and the password unchanged, or, without a password, while the GitHub confirmation is still recent (`reauthedSessionFilter`), else it answers `403` and deletes nothing. Adding a passkey is only written while the session that sends it is still live.

Adding a passkey (with its name) and deleting one mail the account's address a [security notice](./email-setup.md#security-notices), since a passkey added from a hijacked session logs in without MFA and survives a password reset.

### `POST /user/passkeys/options`

Body: the confirmation above. Answers `200` with the WebAuthn creation options (`PublicKeyCredentialCreationOptionsJSON`) and sets the `__Host-VB-PASSKEY-REG` cookie. The options ask for a discoverable credential (`residentKey: "required"`) with user verification, and list the account's passkeys in `excludeCredentials`, so the same authenticator isn't registered twice. An account that already has 10 passkeys (`PASSKEYS_PER_ACCOUNT`) gets `409`.

The frontend passes the options to `PublicKeyCredential.parseCreationOptionsFromJSON()` (or `startRegistration()` of `@simplewebauthn/browser`), calls `navigator.credentials.create()` and sends the result's `toJSON()` to `POST /user/passkeys`, with `credentials: "include"` so the cookie goes along.

### `POST /user/passkeys`

Body: `{"name": "…", "response": <RegistrationResponseJSON>}`. The name is trimmed and has to be 1 to 64 characters. It can't contain control, format, line or paragraph separator characters (`\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`: no line breaks, tabs, zero-width or bidi characters), except the joiners and tags inside emoji that usernames allow too, since it goes into the [security notice](./email-setup.md#security-notices). It's checked before the challenge, so a bad name doesn't use it up.

```json
{
    "message": "Passkey added successfully.",
    "passkey": { "id": "<credential id>", "name": "Laptop", "createdAt": "2026-11-15T10:00:00.000Z", "lastUsedAt": null }
}
```

| Status | `error` | When |
| --- | --- | --- |
| `201` | | Added |
| `400` | `You must provide a name for the passkey.` | `name` is missing, blank or not a string |
| `400` | `The passkey name can be at most 64 characters long.` | `name` is too long |
| `400` | `The passkey name can't contain line breaks or invisible formatting characters.` | `name` has a character the rule above refuses |
| `400` | `You must provide the passkey's response from navigator.credentials.` | `response` isn't an object |
| `400` | `The passkey request expired or was already used: start again.` | No `__Host-VB-PASSKEY-REG` cookie, or its challenge expired, was used, belongs to another account or is a login challenge |
| `400` | `The passkey couldn't be verified: start again.` | The response doesn't verify: wrong challenge, origin or RP ID, no user verification, an unsupported key type or a malformed response |
| `409` | `This passkey is already registered.` | This account or another one already has the credential |
| `409` | `An account can have at most 10 passkeys: delete one first.` | The account reached the cap meanwhile |

### `GET /user/passkeys`

```json
{ "passkeys": [{ "id": "<credential id>", "name": "Laptop", "createdAt": "…", "lastUsedAt": "…" }] }
```

`lastUsedAt` is `null` until the passkey's first login. No key material is returned. `GET /user` (and the superuser's `GET /admin/users/:id`) shows the count as `mfa.passkeys`.

### `PATCH /user/passkeys/:id`

Body: `{"name": "…"}`, with the same rules as above. Renaming needs no password or GitHub confirmation, since the name is only a label. `:id` is the credential id from the list. Answers `200` with `{"message": "Passkey renamed successfully."}`, `400` for the name, and `404` (`There is no such passkey on this account.`) when the account has no passkey with that id, including one of another account.

### `DELETE /user/passkeys/:id`

Body: the confirmation above. Answers `200` with `{"message": "Passkey deleted successfully."}`, or `404` like the rename. The passkey can't log in afterwards; the browser or password manager keeps its copy until the user removes it there. Deleting the last one takes `passkey` off the [MFA](./mfa.md#passkeys-as-a-second-factor) methods.

## Passkeys and MFA

Passkeys don't turn MFA on by themselves: a password or GitHub login of an account with passkeys and no other MFA method starts a session at once, as before. Once another method is on (e-mail MFA, later TOTP), a password or GitHub login answers `202` with `passkey` among the `methods`, and a passkey can pass the second step (`POST /auth/mfa/passkey/options`, then `POST /auth/mfa/verify` with `method: "passkey"`, see [mfa](./mfa.md#passkeys-as-a-second-factor)). Turning that method off, or an admin MFA reset, keeps the passkeys and makes logins plain again.

## Logging in with a passkey

### `POST /auth/passkey/options`

No body and no session needed. Answers `200` with the WebAuthn request options (`PublicKeyCredentialRequestOptionsJSON`, with user verification required and no `allowCredentials`, so the browser offers every passkey it has for the site) and sets the `__Host-VB-PASSKEY-LOGIN` cookie. The frontend passes them to `PublicKeyCredential.parseRequestOptionsFromJSON()` (or `startAuthentication()` of `@simplewebauthn/browser`), calls `navigator.credentials.get()` and sends the result's `toJSON()` to `POST /auth/passkey`.

### `POST /auth/passkey`

Body: `{"response": <AuthenticationResponseJSON>}`. It checks the challenge, the credential, the user handle, the origin and RP ID, user verification, the signature and the signature counter (a counter that didn't grow, when the authenticator keeps one, is refused as a possible clone), then stores the new counter and `lastUsedAt`.

On success it answers `200` with `{"message": "Login successful with user <username>."}` and sets the `__Host-VB-AUTH` cookie like `POST /auth/login`: the account's other session ends. It skips every MFA method that's on (e-mail MFA included), since a passkey with user verification is already two factors, and it removes a waiting MFA challenge of the account, like any new login: its `__Host-VB-MFA` cookie then answers `403`. After a password or GitHub login, a passkey can answer the [MFA](./mfa.md#passkeys-as-a-second-factor) second step instead. It doesn't set the `VB-DEVICE` cookie, which only serves password logins.

| Status | `error` | When |
| --- | --- | --- |
| `400` | `You must provide the passkey's response from navigator.credentials.` | `response` isn't an object |
| `403` | `The passkey couldn't be verified: try again or log in another way.` | Anything else that fails: no or a used-up challenge, an unknown or deleted credential, a wrong user handle, origin, RP ID or signature, no user verification, a counter that went back, an account deleted while the login ran |
| `403` | `This account is suspended: it can't log in until the superuser lifts the suspension.` | The passkey verified, but the account is suspended, also when the suspension lands while the login runs. No session starts, and the new counter and `lastUsedAt` are only stored when the suspension landed after they were |

## Limits

- `POST /auth/passkey/options`, `POST /user/passkeys/options` and `POST /auth/mfa/passkey/options` together allow 30 requests per client IP per minute (`passkeyOptionsPerIp`), since every request stores a challenge.
- Failed `POST /auth/passkey` logins (the `403`s) count 100 per client IP per 15 minutes (`passkeyLoginsPerIp`).
- Over a limit they answer `429` with `error` and `retryAfter`, like the other limiters, and the superuser can clear both with [`DELETE /admin/rate-limits`](./admin-endpoints.md#delete-adminrate-limits) and an `ip`.
- The numbers are in `src/constants/limits.ts` (`PASSKEYS_PER_ACCOUNT`, `PASSKEY_NAME_MAX_LENGTH`, `PASSKEY_CHALLENGE_MINUTES`, `PASSKEY_OPTIONS_*`).

## Tests

`src/tests/passkeys.test.ts` drives the endpoints with a software authenticator (`src/tests/helpers/passkeys.ts`): an ES256 key from Node's `crypto`, `none` attestation and authenticator data encoded with the library's CBOR helpers, and `clientDataJSON` for the origin from `BASE_SITE_URL`, so no browser is needed.
