# ShareX

Ready-made [ShareX](https://getsharex.com) custom uploaders send screenshots, files, text and links to the API with an [API key](./api-keys.md). Each is one `.sxcu` file, served by a public route:

| File | Capabilities | Calls | Key scope | Link ShareX copies |
| --- | --- | --- | --- | --- |
| `GET /sharex/upload.sxcu` | Image uploader, File uploader | `POST /upload` (public visibility) | `uploads:write` | the upload's `url` (a `cdn` link) |
| `GET /sharex/paste.sxcu` | Text uploader | `POST /paste` | `pastes:write` | `<BASE_SITE_URL>/pastebin/<id>` |
| `GET /sharex/shorten.sxcu` | URL shortener | `POST /shortenUrl` | `shortUrls:write` | `<API>/r/<code>` |

One key with the three scopes works in all three files. The routes need no login or key and take no parameters.

## What the files contain

- Each answer is the uploader as JSON with `Content-Disposition: attachment; filename="vb2007-<name>.sxcu"` and `Cache-Control: private, no-store`.
- The `Authorization` header holds the placeholder `Bearer vbk_YOUR_TOKEN`. The token is never sent to these routes (a key never goes in a URL): create a key with `POST /user/api-keys`, replace the placeholder in the file with its `token`, then import it.
- The API's own address in `RequestURL` and in the short link is built from the request: `X-Forwarded-Proto` or the connection's protocol, plus the `Host` header, so a file fetched from `https://api.vb2007.hu` points at `https://api.vb2007.hu`. A `Host` that isn't a plain host name with an optional port answers `400` (`The Host header must be a plain host name with an optional port.`), and the answer is never cached, so a forged header can't poison a shared cache. The paste link uses `BASE_SITE_URL` instead.
- The upload file sets `visibility` to `public`. Private uploads' links expire after an hour, which is no use for sharing; change `Arguments` in the file for private ones. Public uploads are discoverable, not only reachable with their link (see [Setting up the cdn's nginx](./cdn-setup.md)).

## Using them

1. Create a key with the three scopes (creating one needs the password, or a GitHub login in the last 10 minutes on an account without one, see [managing keys](./api-keys.md#managing-keys)).
2. Replace `vbk_YOUR_TOKEN` in the files with the token, which is shown once.
3. Double-click each `.sxcu` file (or **Destinations → Custom uploader settings → Import**).
4. Under **Destinations**, pick the matching uploader for each slot: **Image uploader** and **File uploader** → `vb2007.hu upload`, **Text uploader** → `vb2007.hu paste`, **URL shortener** → `vb2007.hu shortener`. ShareX remembers the choice by position in its uploader list, so a slot left on another entry sends the wrong request: a screenshot sent to a JSON uploader fails with `Unsupported request format JSON`, and a shortened link can end up as a paste.
5. Try each with **Custom uploader settings → Test**.

## Notes

- The paste file puts ShareX's `{input}` into a JSON string. Plain text works; if text with quotes or line breaks arrives mangled, send it with the upload file instead, which stores it as a `.txt` file (`text/plain` is an allowed type). A paste has to fit the paste length limit (`PASTE_MAX_LENGTH`).
- ShareX opens a deletion URL with `GET`, which can't delete anything here, so the files have none.
- A key sends `Authorization` on every call, so rejected keys count toward the [API key limit](./api-keys.md#authenticating-with-a-key).
