# Live API probe — how to run it

This settles the open questions in [`PLAN.md` §11](./PLAN.md#11-live-probe-checklist)
against your real GoPro Cloud account, because GoPro publishes no documentation for
its cloud API and the answers cannot be looked up.

## What the probe does — and does not do

**Does:** issues ~27 read-only `GET` requests to `api.gopro.com` to discover the media
object schema, valid query parameters, the collections/albums endpoint, and how file
variants are exposed.

**Does not:** download any media bytes, upload anything, modify anything, delete
anything, or make any request other than `GET`. Total runtime is well under a minute.

Review every request before running it:

```bash
python3 tools/probe_gopro.py --dry-run
```

## Token safety

The probe reads your token from a file you create yourself. **Do not paste the token
into the chat** — it never needs to enter the conversation, and this way it doesn't
end up in a transcript. The token also never appears in the probe's output: signed CDN
URLs are stripped of their credentials and anything JWT-shaped is redacted before
results are written.

## Step 1 — get your token

1. In Chrome, log in at <https://gopro.com/media-library>.
2. Open DevTools (`⌥⌘I`) → **Network** tab.
3. Reload the page and click any request to `api.gopro.com`.
4. Under **Request Headers**, find `Authorization: Bearer eyJhbGc...`
5. Copy everything *after* `Bearer ` (a long string starting `eyJ`).

<details>
<summary>Alternative: read it from cookies</summary>

DevTools → **Application** → Storage → Cookies → `https://gopro.com` → copy the value
of `gp_access_token`.
</details>

## Step 2 — save it

Run this in your terminal, paste the token, then press **Enter** and **Ctrl-D**.
Using `cat` rather than `echo` keeps the token out of your shell history:

```bash
mkdir -p ~/.go2cloud && chmod 700 ~/.go2cloud
cat > ~/.go2cloud/probe_token
chmod 600 ~/.go2cloud/probe_token
```

## Step 3 — run it

```bash
cd go2cloud && python3 tools/probe_gopro.py
```

Results are written to `docs/probe-results.json` and `docs/probe-results.md`.

## Notes

- The token is short-lived. If you get `401`, repeat Step 1 — it has expired.
- Requires an active **GoPro Premium / Premium+** subscription with media in the cloud.
- Requests are issued sequentially with a 0.6 s delay and capped at 70 total, to stay
  comfortably inside any rate limit.
- Delete the token when you're done: `rm ~/.go2cloud/probe_token`
