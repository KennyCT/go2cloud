# go2cloud — Project Plan

**Status:** §11 research complete · **live probe run 2026-08-23 against a real account** · **Updated:** 2026-08-23 · **Repo:** `KennyCT/go2cloud`

Pipeline tool that streams GoPro Cloud media into Google Photos without staging files on local disk.

> **Revision note.** This document was substantially revised after the §11 research pass
> (8 parallel topics, 197 findings, adversarial audit of 40 "verified" claims of which 19 were
> downgraded or refuted). Several original decisions were **wrong** and are corrected below;
> each correction is marked ⚠️. Items still requiring live credentials are tracked in §11.

---

## 1. Problem

Moving GoPro Cloud footage to Google Photos today means: download to device → wait → upload →
wait → delete the local copy to reclaim space. GoPro records at high bitrates, so this is slow,
storage-hungry, and needs babysitting.

go2cloud automates the path and removes the disk cost entirely.

---

## 2. What the APIs actually permit

### 2.1 There is no true cloud-to-cloud transfer

The Google Photos API has **no import-from-URL capability** — uploads require `POST`ing raw
bytes. GoPro offers no export-to-Google integration. **Bytes must pass through a machine we
control.**

| Original pain point | Solved? | Mechanism |
| --- | --- | --- |
| Device storage fills up; manual deletes | ✅ Fully | Stream GoPro CDN → bounded memory → Google resumable upload. Peak disk ≈ 0. |
| Transfer takes a long time | ⚠️ Partly | Bytes still traverse the local connection once. |

The current manual flow is *serial* and *supervised*. Streaming overlaps both legs, so
wall-clock collapses to roughly the upload leg alone, runs unattended, parallelises, and
resumes after crash or sleep. **Upload bandwidth is the hard floor** — 200 GB at 40 Mbps is
~11 hours regardless of implementation quality. The win is *unattended and resumable*.

**Additional constraint discovered:** GoPro's CORS allowlist covers only `gopro.com` origins,
so the GoPro half **can never run from browser JavaScript**. This permanently locks in the
server-side/Node architecture — a browser-only version of this tool is impossible.

### 2.2 Google Photos: writing into pre-existing albums is impossible — confirmed absolute

Effective 2025-03-31 the `photoslibrary.readonly`, `.sharing`, and broad `photoslibrary`
scopes were removed. `photoslibrary.appendonly` still permits uploading bytes, creating media
items, and creating albums — but only albums **the app itself created**.

- ✅ Upload straight into the library — supported
- ✅ Create a new named album and upload into it — supported
- ❌ Upload into an album created in the Google Photos app — **impossible**

Three independent locks confirm this: the docs state it; `batchCreate` and
`albums.batchAddMediaItems` both require app-created albums; and `albums.list` cannot even
return a non-app album's id (all `sharedAlbums.*` methods return `403` since 2025-03-31).

**"Existing album" means "an album go2cloud created on a previous run."** Album capacity is
**20,000 items**.

> **Trap:** the live discovery document (revision 20260820) *still advertises the three removed
> scopes and the removed `sharedAlbums.*` methods*. Never generate the scope list from
> discovery — hardcode it.

### 2.3 Storage quota

**Every API upload is stored at Original quality and counts against the Google account quota.**
There is no Storage Saver option. Confirmed: 2 TB Google One plan in place for this project.

⚠️ **No undo exists.** The Google Photos API cannot delete media items or albums. A cancelled
or mistaken run leaves everything in the library, consuming storage, until manually deleted in
the app. This makes the pre-flight gate load-bearing rather than a nicety.

### 2.4 GoPro has no official cloud API

Open GoPro covers camera BLE/WiFi only. All clients target the undocumented endpoints backing
gopro.com's media library. Verified request mechanics:

```http
GET https://api.gopro.com/media/search
      ?fields=…&type=…&processing_states=…&order_by=…&per_page=…&page=…&captured_range=…
GET https://api.gopro.com/media/{id}/download
GET https://api.gopro.com/collections            ·  GET /collections/{id}/media
GET https://api.gopro.com/media/items            ·  (albums; see §11 U5)

Authorization: Bearer <token>
Accept: application/vnd.gopro.jk.media+json; version=2.0.0
```

**The vendor `Accept` header is mandatory and content negotiation runs *before* authentication.**
Error taxonomy is three-way, not two-way:

| Response | Meaning |
| --- | --- |
| `406` | Accept header missing or unrecognised |
| `410 Gone` | Wrong vendor version — **canary for API deprecation, alert on it** |
| `401` | Credentials rejected |
| `500` on an authenticated call | May *also* mean a dead token — attempt one refresh before classifying as transient |

The mediatype registry is global rather than per-route, so **one constant suffices for the
whole client**. No User-Agent, Origin, or Referer is required. `/v1/*` endpoints do not need a
vendor mediatype.

⚠️ **`/media/search` returns intermittently incomplete pages — reproduced live.** In one probe run
`per_page=100` and `per_page=200` both returned **12 rows** while reporting `total_items: 212` and
`total_pages: 2`; minutes later the identical `per_page=100` request returned a full 100. A
third-party verifier ships a retry loop under the comment *"Sometimes it doesn't return all items
from the first try."*

This is the single most dangerous behaviour in the whole API: **the short page is indistinguishable
from a complete one** — status is `200`, `_pages` looks coherent, and a naive scanner would have
indexed 24 of 212 items and reported success. Mandatory mitigation:

- Use **`per_page=50`** (walked 212/212 reliably; larger pages were the ones observed to truncate).
- After each page assert `len(media) == min(per_page, total_items - offset)`; on mismatch, retry
  that page with backoff before accepting it.
- After a full walk, assert `len(unique ids) == total_items` and refuse to proceed if short.
- `total_items` itself **is** trustworthy — per-type totals summed to exactly 212.

Requires an active **GoPro Premium / Premium+** subscription. GoPro's Terms permit account
suspension at their discretion and undocumented endpoints can change without notice; go2cloud
accesses only the user's own media, read-only, rate-limited, with no delete capability.

### 2.5 Correctness traps — several corrected since the first draft

1. **`creationTime` cannot be set or corrected by any API.** It appears exactly once in the v1
   surface, output-only. The displayed date comes entirely from embedded metadata in the bytes
   sent, falling back to upload date when absent. **Byte-for-byte pass-through is a correctness
   requirement, not a preference.**
2. ⚠️ **`_embedded.files[]` is NOT the original for video — it is a 1080p proxy.** Captured
   responses show `files[0]` at 1920×1080 while the `source` variation is 2704×1520 or 3840×2160.
   Defaulting to `files[0]` silently uploads a re-encode *and* loses capture metadata.
   **Originals are `variations[].label ∈ {source, baked_source}`. Never take `variations[0]`** —
   in one live response that is `edit_proxy`.
3. ⚠️ **Chaptered videos are ONE media id with MULTIPLE `source` variations**, distinguished by
   `item_number` 1..N — *not* separate media items as the first draft claimed. A server-side
   `concat` variation also exists. **This was a data-loss bug: a `media_id`-keyed state model
   silently drops chapters 2..N.** See §3.1.
4. **Signed CDN URLs expire in exactly 3600 seconds.** Measured at 3599.18 s across every
   variation of one medium. A 20 GB clip at 40 Mbps takes ~67 minutes — **longer than its own
   source URL lives.** Mid-file re-resolve is mandatory, not defensive.
5. **Rejection happens at `batchCreate`, not at upload.** An undecodable file receives a valid
   upload token, then fails with `status.code 3`. **You pay full upload bandwidth before learning
   it is rejected**, which makes client-side pre-filtering a bandwidth optimisation.
6. ⚠️ **`.LRV` / `.THM` proxy files fail *silently by succeeding*.** They are ordinary MP4/JPEG,
   so Google Photos accepts them happily — flooding the library with low-res duplicates and
   fisheye thumbnails. Unlike `.360`, this failure does not self-correct. Filter at the
   variation-selection layer *and* denylist by extension.
7. **Hard caps:** photos ≤ 200 MB, videos ≤ 20 GB (⚠️ Google's consumer docs say 10 GB — the two
   current pages contradict; gate on `HEAD` `Content-Length` and handle failure gracefully).
   `batchCreate` ≤ 50 items.
8. **Google dedupes by content** — identical bytes yield the same `mediaItem.id` even under a
   different upload token, so retrying an ambiguous failure will not duplicate. Any remux
   produces a genuine duplicate.
9. **Google Photos is not a fidelity-preserving backup.** API downloads are re-compressed and
   EXIF location is stripped. Round-trip verification would produce false negatives; only
   Takeout can verify stored bytes. The README must not claim "backup."

---

## 3. Decisions (locked)

| Area | Decision | Rationale |
| --- | --- | --- |
| Stack | **TypeScript / Node ≥22.5** (installed: Node 24 LTS via fnm, pnpm 11) | One language across engine, CLI, UI. Also forced by GoPro's CORS policy (§2.1). |
| Interfaces | **CLI + local web UI**, one shared core | Loopback OAuth needs a local server anyway. |
| GoPro auth | **Playwright capture to bootstrap + real OAuth refresh loop** ⚠️ *changed* | Research found a live token endpoint with working published client credentials. See §5.1. |
| Google auth | **BYO OAuth client, self-published to Production** ⚠️ *changed* | Removes the 7-day re-consent entirely. See §5.2. |
| Deployment | **Local-first + optional Docker** | Zero cost; tokens never leave user hardware. |
| Cloud compute | **Rejected** | Free-tier egress is 1 GB/mo; beyond that ~$0.12/GB. Also relocates tokens onto a server. |
| Audience | **Public open-source tool**, MIT | Drives the setup wizard, docs, disclaimers. |
| V1 scope | **CLI pipeline end-to-end first** | Proves streaming, resume, and quota before UI work. |
| Scale target | **100 GB – 2 TB**, 2 TB Google One confirmed | Prioritises resume, throughput, batching. |

---

## 4. Architecture

```
go2cloud/  (pnpm workspace)
├─ packages/core/    Engine: GoPro client, Google client, transfer pipeline, SQLite state
├─ packages/cli/     Commander + @clack/prompts; hosts `go2cloud ui`
├─ packages/web/     Vite + React dashboard (cosmic theme)
├─ tools/            probe_gopro.py — read-only API probe (§11)
├─ docker/           Unattended self-hosting
└─ docs/             PLAN.md · PROBE.md · SETUP.md · probe-results.*
```

`core` has zero UI dependencies. CLI and web are thin adapters over it. State lives in
`~/.go2cloud/`, outside the repo.

**Dependencies — deliberately minimal:** `undici` (streaming with real backpressure), `zod`,
plus `playwright` (bootstrap capture), `@napi-rs/keyring` (chosen over the deprecated `keytar`)
and `fastify` (local UI server) as those milestones land. OAuth is hand-rolled against the token
endpoint — `google-auth-library` is not needed for a loopback/PKCE flow.

⚠️ **State uses Node's built-in `node:sqlite`, not `better-sqlite3`.** Verified stable (no
experimental warning) on Node 24.19 with SQLite 3.53.3. This removes a native addon that requires
node-gyp compilation, a pnpm build-script approval, and per-platform binaries — all of which are
real friction for a public tool's contributors. **Raises the floor to Node ≥ 22.5.**

---

## 5. Authentication

### 5.1 GoPro — browser login, valid for a week ⚠️ *revised twice*

> **Corrected 2026-08-23 by live testing.** The refresh-loop plan below does not work
> from a browser login, and the replacement is simpler than either earlier version.
>
> GoPro's web login is a **server-side form POST to `gopro.com/login` that sets a
> cookie**. It never calls `/v1/oauth2/token`, so **no refresh token is obtainable**
> by watching the network during login. That endpoint is real — research verified it
> discriminates valid client credentials — but it serves the mobile apps, and the only
> grant that reaches it needs the user's password, which go2cloud will not handle.
>
> **The session cookie is valid for 168 hours.** Playwright reports the cookie's own
> expiry, so this is read rather than assumed. The practical outcome is a **weekly**
> sign-in, not the hourly one an earlier draft feared — good enough that chasing a
> refresh token is not worth the password-handling risk.
>
> `go2cloud auth gopro` therefore opens GoPro's real login page, captures the cookie
> and its true expiry, and stores both in the keychain. A `401` remains authoritative
> regardless of the recorded expiry.

### 5.1a Original refresh-loop design (retained for context)

The original plan required re-running Playwright capture whenever the token expired. Research
found `POST https://api.gopro.com/v1/oauth2/token` is live and the long-published client
credentials still authenticate — verified by error discrimination: a refresh_token grant with
those credentials and a garbage token returns `invalid_grant`, whereas garbage credentials
return `invalid_client`.

1. `go2cloud auth gopro` opens an isolated Playwright Chromium at GoPro's genuine login page.
   The user logs in themselves, including 2FA. **Credentials never pass through go2cloud.**
2. Capture the full bundle — `{access_token, expires_in, refresh_token, resource_owner_id,
   obtained_at}` — into the OS keychain, not just the token.
3. **Refresh via `grant_type=refresh_token` 30 minutes before expiry** (a long upload can
   straddle a boundary).
4. `--paste` fallback for a manually copied token.
5. `--password` as an optional non-interactive path for CI/Docker (may be blocked for 2FA/social
   accounts — §11 U3).

Do **not** parse the token's `exp` claim — it may be a JWE. Use `expires_in`, and treat `401`
(or an authenticated `500`) as the expiry signal.

Until §11 U1 resolves, send the token **both** ways — `Authorization: Bearer` *and*
`Cookie: gp_access_token=…; gp_user_id=…`. It costs nothing and is strictly more likely to work.

### 5.2 Google — BYO client, published to Production ⚠️ *revised*

**The original recommendation of Testing mode was based on a wrong premise.** Two corrections:

- **Photos scopes are *sensitive*, not *restricted*.** Google's authoritative restricted list
  covers Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient, and Health — no
  `photoslibrary.*` entry. **The §13 claim that a shared client would need a paid annual CASA
  assessment was therefore wrong** — CASA applies only to restricted scopes.
- **The 7-day refresh expiry is conditioned solely on `publishing status = Testing`**, not on
  verification. Google explicitly permits publishing to Production **without** verification
  under the personal-use exception (<100 users). Consequences: an "unverified app" interstitial
  the user clicks through via *Advanced → Go to \<app\>*, and a 100-new-user lifetime cap.

> **Approved 2026-08-23:** proceed with self-published Production **conditional on the live
> confirmation in M3** (probes U18/U19/U20). If publishing is refused without a verified domain,
> or refresh tokens still die at day 7, fall back to Testing mode and document the weekly re-auth.

Corroborated by three independent production users: Home Assistant's official Google Photos
integration ("set Publish Status to Production. Otherwise, your credentials will expire every
7 days"), rclone's docs, and the Google Ads API Team. **rclone ships exactly the three Photos
scopes go2cloud needs with the same BYO + self-publish workflow.**

**Scopes (hardcoded, never from discovery):**
`photoslibrary.appendonly` · `photoslibrary.readonly.appcreateddata` ·
`photoslibrary.edit.appcreateddata` (only if setting album covers)

**One Cloud project serves every Google account you own.** The OAuth client identifies the
*application*, not the user: because the app is published to Production (unverified), any Google
account can consent to the same client and receives its own refresh token. The only ceiling is
Google's 100-new-users-lifetime cap for unverified apps, which personal use never approaches.
go2cloud exposes this as `--profile`, namespacing tokens *and* the transfer database per account —
sharing one database would let a transfer to account A mark work "done" for account B.

**Client type: "Desktop app"** — no redirect URI to register, any ephemeral port, and Google
still issues the `client_secret` the token exchange expects. "Web application" would force
pre-registering an exact port.

**Wizard must handle three expiry cliffs the first draft missed:**
- Client secrets are shown **once, at creation** (masked permanently since Nov 2025) — the wizard
  must say "click DOWNLOAD JSON now" and accept that file as input.
- **OAuth clients inactive for 6 months are auto-deleted** (`deleted_client`, restorable 30 days).
- **Refresh tokens die if unused for 6 months**, and Google keeps only **100 per account per
  client id** — a 101st silently invalidates the oldest. Never re-consent gratuitously.

---

### 5.3 ⚠️ Publishing requires public URLs — U19 answered, and it hurts the public story

**Confirmed live 2026-08-23.** Switching an External app to Production is refused until *app name,
support email, **homepage URL** and **privacy policy URL*** are all populated:

> *"Valid app name, support email, homepage url, and privacy policy url are required for switching
> the app to external production mode."*

✅ **RESOLVED 2026-08-23: publishing then succeeded.** With the four fields populated — using
`https://github.com/KennyCT/go2cloud` as homepage and `.../blob/main/PRIVACY.md` as privacy policy,
**on a domain the developer does not own** — the app published to Production without objection.

This confirms the reading: the console enforces **field presence**, not **domain ownership**.
Search Console domain verification is a requirement of *submitting for verification*, a path
go2cloud deliberately does not take.

A persistent banner then appears — *"Your app requires verification. When you have finished
configuring your information, please submit your app for review."* This is the standard unverified
+ sensitive-scope nag. It is **advisory, not a block**: publishing status is *In production* and
the 7-day refresh fuse should be gone (U18 confirms on day 8). Whether it constrains API calls is
U20, which the probe suite exercises directly.

Google's policy guidance additionally states the privacy policy *should* be hosted on the same
domain as the homepage, so both URLs should share a host.

**Consequence for go2cloud as a public tool.** This is the finding with the largest strategic
weight so far. Escaping the 7-day re-auth now requires every user to publish their own app, which
requires every user to supply a homepage and a privacy policy URL. Most users have neither.

The realistic end-user options therefore become:

| Path | Cost to the user |
| --- | --- |
| Accept Testing mode | Re-consent **every 7 days**, forever |
| Publish with go2cloud's own public URLs | ✅ **Verified to work.** Still arguably misrepresents authorship, and every user must find and paste them |
| Publish with the user's own domain | Requires owning a domain — unrealistic for most |

⚠️ **This materially strengthens the case for the verified shared client in §13.** A one-off
~10-business-day sensitive-scope verification by the maintainer would remove Google Cloud setup
*entirely* for every user — no project, no client, no URLs, no weekly re-auth. Given U19, that
shifts from "nice future polish" to **the only path that makes go2cloud pleasant for anyone who
isn't its author.** It should be promoted to a v1.0 goal rather than deferred indefinitely.

## 6. Data model (SQLite)

| Table | Purpose |
| --- | --- |
| `accounts` | provider, subject, keychain reference (never the token) |
| `gopro_media` | id, filename, file_extension, type, captured_at, captured_at_timezone, created_at, item_count, mce_type, play_as, file_size, raw JSON, scanned_at |
| `gopro_albums` | id, title, label, media_count, revision_number, source (`collections` \| `media_items`) |
| `gopro_album_members` | album_id, gopro_media_id — built by the N+1 pass (§7.4) |
| `google_albums` | id, title, item_count — **app-created only** |
| `transfers` | **PK `(gopro_media_id, item_number)`** ⚠️, variation_label, target_album_id, state, bytes_total, bytes_sent, upload_url, upload_token, google_media_item_id, attempts, last_error |
| `settings` | concurrency, chunk policy, defaults |

⚠️ **The `transfers` primary key is `(gopro_media_id, item_number)`, not `gopro_media_id`.**
A chaptered video is one media id with N chapters; keying on media id alone silently drops
chapters 2..N. Same for Burst/TimeLapse, where N frames become N Google Photos items.

**States:** `pending → resolving → uploading → creating → verified`, terminal `skipped` / `failed`.

The `(gopro_media_id, item_number) → google_media_item_id` mapping makes re-runs idempotent and
is the backbone of resume.

---

## 7. Transfer engine

### 7.1 Per-item flow

1. **Resolve** the download manifest from `/media/{id}/download` — never cached, never persisted.
2. **Select** the asset per §7.5.
3. **`HEAD`** the variation's `head` URL for an exact `Content-Length`.
4. **Open** a Google resumable session: `POST /v1/uploads` with `X-Goog-Upload-Command: start`,
   `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Content-Type`, `X-Goog-Upload-Raw-Size`.
   Read `X-Goog-Upload-Chunk-Granularity` from the response — **never hardcode 262144**.
5. **Stream** GoPro CDN → Google. ⚠️ **`POST`, not `PUT`** (the first draft was wrong), with
   `Authorization` on every phase. Final chunk uses the literal command `upload, finalize`.
6. **Finalize** → the upload token arrives as **raw text in the body**, not JSON.
7. **Create** via `mediaItems:batchCreate`, batched by `(user, albumId)`.
8. **Verify** and record the media item id.

> **Header trap:** Photos uses `X-Goog-Upload-Raw-Size` / `-Content-Type`. Street View, Gemini
> Files, and Firebase Storage use `X-Goog-Upload-Header-Content-Length` / `-Content-Type`.
> Copying from those docs fails on Photos. There is also **no `308`** in this protocol — success
> is `200` everywhere; do not port Firebase's `308` leniency.

✅ **Verified live 2026-08-23** (all against the real API):

- **`X-Goog-Upload-Raw-Size` is NOT mandatory.** Sessions opened successfully with the header
  omitted, with it set to `0`, and with the Street-View alias substituted — all returned `200`
  with a usable session URL. ⚠️ *Only session opening was tested; a full streaming upload with an
  undeclared total was not.* Keep the GoPro `HEAD` until that is proven, then drop it.
- **Chunk granularity is always `262144`** — identical for 1 MB / 200 MB / 5 GB declared sizes and
  for both `image/jpeg` and `video/mp4`. Still read it from the response rather than hardcoding.
- **Every protocol violation returns plain `400` with no `X-Goog-Upload-Status` header:**

  | Action | Result |
  | --- | --- |
  | Chunk at a skipped offset | `400` — *not* the `409` Google's reference server implies |
  | Re-sending an already-committed offset | `400` — **replay is NOT idempotent** |
  | Misaligned non-final chunk (300000 bytes) | `400` — granularity is enforced |
  | Query on a corrupted session URL | `400` — same code as all of the above |

- **The session survives a rejected chunk.** After a bad-offset `400`, `query` still returned
  `active` with the correct committed offset. Recovery works.

⚠️ **`400` is ambiguous** — it means both "bad chunk, session healthy" and "session gone". The
disambiguator is a follow-up `query`:

```
on 400 from a chunk POST:
    q = query(session_url)
    if q is 200 and status == "active":  resume from q.size_received   # never replay blindly
    else:                                session is dead -> restart the upload
```

### 7.2 The 1-hour CDN window — the hardest constraint

Every ranged GET after 60 minutes `403`s. Required behaviour:

1. Never persist download URLs; persist media ids and resolve lazily.
2. Track `url_expires_at` (parse `Expires` from the CloudFront query string) and **pre-emptively
   re-resolve at T−60s** rather than waiting for a `403`.
3. On `403`/`401` from the CDN, re-call `/media/{id}/download`, re-select the same
   `(label, item_number)`, and continue the ranged GET at the current offset.
4. The Google session is unaffected — its offset is authoritative and the session lives **7 days**
   (the upload *token*, once finalized, lives **24 hours**).
5. **Persist the session URL and resume across process restarts.** On restart, query the stored
   session: if Google still reports it `active`, continue from its committed offset instead of
   re-sending. A 4-hour run proved the need — three files over 5 GB each outlived their download
   URL and were rescued mid-flight, but a process crash would still have restarted them from zero.

### 7.3 Chunking — quota-free, so resume granularity is the only tradeoff

✅ **U4 settled live, 2026-08-23.** A differential test made **32 requests to `/v1/uploads`**
(1 session start + 31 chunk `POST`s) and **zero** Library API JSON calls. The project's daily
request counter **did not move** — it read 12 before and 12 after.

**Upload byte traffic does not consume the 10,000/day Library API quota.** That quota is spent
only by JSON methods: `mediaItems:batchCreate`, `albums.create`, `albums.list`,
`mediaItems:search`.

> *Confidence:* the non-increment is directly observed. The identification of that counter as the
> 10,000/day Library API quota is inferred from its value matching the JSON-call count almost
> exactly (12 observed vs ~12 expected, against ~78 total HTTP requests).

**This reverses the plan's most conservative decision.** Chunked uploads were previously feared
prohibitive — a 20 GB video at 256 KiB granularity is 81,920 requests, which would have been 8×
the entire daily quota for a single file. That fear was unfounded.

**Revised policy:**

| File size | Mode | Why |
| --- | --- | --- |
| < 256 MB | Single request (`upload, finalize` at offset 0) | Fewer round trips; Google's own recommendation |
| ≥ 256 MB | **Chunked, 64 MB chunks** | Resume granularity. A failure costs one chunk, not the whole file |

Chunk size is now purely a **memory and resume-granularity** decision, not a quota one. 64 MB ×
3 concurrent files ≈ 192 MB peak RAM, and a dropped connection on a 20 GB clip costs ≤ 64 MB of
re-transfer instead of restarting from zero. Non-final chunks must satisfy
`size % granularity == 0`; granularity is `262144` (invariant across every size and MIME type
tested) but should still be read from the start response.

**Revised throughput ceiling.** The old "~9,800 items/day" figure was wrong — it assumed one quota
unit per item. With `batchCreate` carrying 50 items per call, 10,000 calls/day allows on the order
of **500,000 items/day**. For a 2 TB library the binding constraint is **bandwidth, not quota**.

A separate 75,000/day media-byte quota exists and may cover upload traffic; at 64 MB chunks that
is ~4.8 TB/day, so it is not a practical limit either. Still log per-item request counts so a
future quota change surfaces early rather than as a mysterious `429`.

### 7.4 Album mapping — solved by `/media/items`

⚠️ **Corrected by the live probe.** `/collections` is the *share-link* system and returned
`total_items: 0` on a real account with 5 albums. **Albums live under `/media/items`:**

| Call | Returns |
| --- | --- |
| `GET /media/items?type=collection` | The album containers — `{type:"collection", id, title, label:"mural", description, place, created_at, updated_at, user_date, parent_ids[], item_ids[]}` |
| `GET /media/items/{album_id}` | One album, **including `item_ids[]`** — membership inline |
| `GET /media/items?parent_id={album_id}` | The member items, each with the **full `medium` object inlined** |

The membership call doubles as a metadata call, so the N+1 pass is cheaper than the first draft
assumed — one request per album yields both membership *and* every member's full metadata, with no
follow-up `/media/search`.

**`/media/search` cannot filter by album.** `parent_id` is present in the default row shape but is
`null` on every row, and passing `?parent_id=` is silently ignored (returns the unfiltered 212).
The join key is `items[].medium.id` — the item wrapper id is a UUID and is **not** the medium id.

⚠️ **Response envelope differs from `/media/search`:** `/media/items` returns a bare
`{items: [...], _pages: {...}}` — **no `_embedded` wrapper**. A shared response parser will break.

Filter on `label` (`mural` = album) client-side; `?label=` and `?root=` are silently ignored,
though `?type=collection` **is** honoured.

### 7.5 Asset selection algorithm

```
1. Skip if play_as == "edl" && mce_type == "user_created"     (Quik edit projects)
2. Skip if file_extension == "360"                            (before any /download call)
3. candidates = variations[] where label ∈ {source, baked_source}
                              and available is not False and url is non-empty
4. If none:
     type ∈ {Burst, TimeLapse} → use ALL of files[]   (N items, item_number 1..N)
     type == Photo             → variations[label=source] exists (settled U9); files[0] matches it
     otherwise                 → largest-area variation, and WARN (degraded + metadata loss)
5. Never touch sprites[] or sidecar_files[]. Never take variations[0] blindly.
6. Denylist .lrv / .thm / .gpr extensions.
```

`sprites` uses plural `urls`/`heads` — a naive `entry['url']` accessor throws.
`sidecar_files` carries GPMF telemetry and stabilisation JSON, never user media.

**Pre-flight optimisation:** `/media/search` exposes `available_labels`, a **superset** of the
`variations[]` labels (it also lists sidecar/derived labels such as `gpmf`, `gpx`, `mediainfo`,
`large`, `master_playlist`). Verified across three media: nothing appeared in `variations[]` that
was absent from `available_labels`. So pre-flight can cheaply answer *"does this item have a
`source`?"* — and flag everything skippable — **without one `/download` call per item**. It cannot
supply URLs or sizes, so the resolve step still runs at transfer time.

⚠️ **Derive the upload filename and MIME from the asset URL's `response-content-disposition`, not
from the library `filename`.** MultiClipEdit rows are named `*.json` while the actual baked
source is `*.mp4` — independently confirmed in JDownloader's source. The CDN's own
`content-type` is the useless `binary/octet-stream`.

### 7.6 Google-side error handling

- **Parse per-item `newMediaItemResults[i].status.code`.** Branch on the integer, never the
  message: `3` INVALID_ARGUMENT → permanent skip · `6` ALREADY_EXISTS → treat as success ·
  `13` INTERNAL → retry with bounded attempts.
  ⚠️ **Verified live: a partial failure returned HTTP `200`, not `207`.** A batch of
  [valid, garbage, valid] came back `200` with per-item codes `0 / 3 / 0` and both valid items
  created. **Never treat HTTP 2xx as success** — this is not a theoretical caution, it is the
  observed default. The `code 3` message was the generic *"Failed: There was an error while trying
  to create this media item."* with no discriminating prefix, confirming that only the integer is
  usable.
- Some failures are **batch-level**: bad `albumId`, full storage, no-permission. Zero items are
  created and all 50 upload tokens remain valid for retry.
- **Byte uploads may be parallel; `batchCreate` must be serial per user** — parallel batchCreate
  is the documented cause of `500`s. N upload workers feed one serial batcher.
- ⚠️ **One bad `fileName` destroys the entire batch.** A 300-character name returned a
  **batch-level** `400 INVALID_ARGUMENT — "File name must not have more than 255 characters."`
  and **zero of the three items were created**, including the two that were perfectly valid.
  Validate every `fileName` client-side (≤255 chars, non-empty) *before* batching — otherwise one
  malformed name costs 50 items' worth of already-uploaded bandwidth.
- ✅ **Content dedupe confirmed, and it is useful.** Identical bytes uploaded under two different
  tokens, two different `fileName`s and two different `albumId`s produced **the same
  `mediaItem.id`**, and that single item was verified present in **both albums**. Two consequences:
  re-running a transfer into a different album correctly files the existing item rather than
  duplicating it, and **the first `fileName` wins** — the second is silently ignored, so a rename
  on re-upload has no effect.
- **De-duplicate upload tokens within each batch**, or chaptered clips manufacture spurious `6`s.
- **Two independent rejection handlers:** `4xx` on `/v1/uploads` (permanent) and per-item status
  on `batchCreate`. Handling only the latter hangs on the former.
- Flush batches on a timer well inside 24 h — upload tokens expire.
- `description` ≤1000 chars, and Google's policy forbids auto-generated text such as filenames —
  **leave it empty**. `simpleMediaItem.fileName` is the only chance to name the item (≤255 chars).
- Retry: `5xx` → exponential backoff from 1 s · `429` → **minimum 30 s** · `404` → session gone,
  restart. An undocumented per-minute write limit exists alongside the daily one; treat repeated
  `500`s as a signal to *reduce concurrency*, not merely back off.

---

## 8. Features

**GoPro side:** select individual media; select albums; filter by media type; choose resolution
variant, defaulting to `source`. **Both date axes filter server-side** (settled by probe):

| Filter | Parameter | Notes |
| --- | --- | --- |
| Capture date | `captured_range=<ISO>,<ISO>` | A zero-width range returns 0 — always send an explicit end-of-day (`T23:59:59.999Z`). |
| **Upload date** | **`created_range=<ISO>,<ISO>`** | ⚠️ *Newly found.* Narrowing to one day cut 212 → 55 while the `zzz_range` control stayed at 212. |
| Last modified | `updated_range=<ISO>,<ISO>` | Also real (212 → 211). |

⚠️ **A malformed range value returns `500`, not `400`.** Validate the `<iso>,<iso>` shape
client-side, and do not treat every `500` as a transient server fault.

**Google side:** upload to library root; create a new named album; or target a previously
go2cloud-created album. Pre-existing Photos albums are unavailable by API design (§2.2).

⚠️ **New option `--chapters=split|concat`.** `concat` uploads the single server-stitched `concat`
variation, producing one continuous clip in Google Photos with **zero ffmpeg and zero disk** —
a genuine alternative to the ffmpeg path the first draft rejected. Default `split`, because
`concat` is a re-render of unverified metadata fidelity and doubles GoPro-side bytes.

**Pre-flight (mandatory):** file count (including chapter expansion), total bytes, estimated
duration, estimated storage impact, N+1 album-scan cost, and every item that will be skipped
with its reason. Requires confirmation — there is no undo (§2.3).

**Also:** `--dry-run`, skip-already-transferred, verification, full resume, and **no
delete-from-GoPro capability of any kind**.

### CLI surface

```
go2cloud auth gopro [--paste|--password]   go2cloud plan [filters]
go2cloud auth google [--setup]             go2cloud transfer [filters] [--dry-run] [--yes]
go2cloud auth status                       go2cloud resume
go2cloud scan [--refresh]                  go2cloud status
go2cloud ls [--from --to --type]           go2cloud verify
go2cloud albums                            go2cloud ui [--port 4173]

Filters: --from --to --album --type --variant
Targets: --to-album <name|id> | --new-album <name>
Tuning:  --concurrency N --chunk-policy single|chunked --chunk-size 256MB --chapters split|concat
```

---

## 9. Web UI

**Connect** → **Library** (grid, filters, selection) → **Destination** → **Pre-flight** →
**Transfer** (live progress over SSE) → **History**.

**Cosmic theme:** deep-space gradient (`#0a0618` → `#131032`) with a subtle animated starfield,
nebula blue/violet primaries (`#6366f1`, `#8b5cf6`), cyan accent (`#22d3ee`) for progress and
success. Glassmorphic panels, monospace for byte counts and rates.

---

## 10. Security

- Tokens in the **OS keychain**; never plaintext, never in the repo.
- Playwright context isolated and destroyed after capture; only the token bundle is extracted.
- OAuth loopback with **PKCE** and `state` verification on a random localhost port.
- Structured logging with token redaction. **No telemetry.**
- All state under `~/.go2cloud/`, outside the working tree.
- Each user runs their own Google Cloud project — no shared client brokers anyone's data.
- The probe tool is read-only (`GET`/`HEAD` only) and redacts tokens and signed CDN credentials
  before writing any output.

---

## 11. Live-probe checklist

### ✅ Settled by research (2026-08-23)

- [x] **Vendor `Accept` header is mandatory**; content negotiation precedes auth; `406`/`410`/`401`
      taxonomy established; one mediatype constant suffices — §2.4
- [x] **GoPro OAuth token endpoint is live** with working published client credentials; refresh
      loop is viable — §5.1
- [x] **Signed CDN URLs last exactly 3600 s**; CloudFront-style `Expires`/`Signature`/`Key-Pair-Id`;
      `HEAD` and `Range` supported; `content-type` is useless — §2.5.4, §7.2
- [x] **Originals are `variations[].label ∈ {source, baked_source}`**; `files[]` is a 1080p proxy
      for video; never take `variations[0]` — §2.5.2
- [x] **Chaptered videos are one media id with N `source` variations** keyed by `item_number`;
      a `concat` variation exists — §2.5.3, §6, §8
- [x] **`/media/search` returns incomplete pages** — page-completeness retry required — §2.4
- [x] **`/collections` is a real root-level path**; `/albums`, `/playlists`, `/projects`, `/moments`
      all `404`; `/collections/{id}/media` supports only `fields`/`page`/`per_page`
      (`order_by`/`type` are silently ignored) — §7.4
- [x] **`/media/search` rows carry no usable collection back-reference** (`parent_id` is always
      `null`; `?parent_id=` is ignored) → album membership must come from `/media/items` — §7.4
- [x] **Google resumable wire protocol** — exact headers, `POST` not `PUT`, no `308`, granularity
      from the start response, 7-day session / 24-hour token — §7.1
- [x] **`batchCreate` semantics** — `207`, per-item integer codes, batch-level failures, serial
      per user, content dedupe, 20,000-item album cap — §7.6
- [x] **Adding to user-created albums is impossible** — confirmed by three independent locks — §2.2
- [x] **Photos scopes are *sensitive*, not *restricted*** → no CASA. §13's original claim was wrong — §5.2
- [x] **The 7-day expiry is a publishing-status problem, not a verification problem**, with three
      independent production precedents — §5.2
- [x] **Desktop app is the correct client type**; secrets shown once; 6-month client/token
      expiry; 100-token-per-account cap — §5.2
- [x] **`creationTime` is unsettable**; rejection happens at `batchCreate` after full bandwidth
      is spent; Photos is not a fidelity-preserving backup — §2.5

### ✅ Settled by the live probe — 2026-08-23, 63 read-only requests

Run against a real account (212 items · 174.3 GB · Video 113 / Photo 91 / MultiClipEdit 7 /
TimeLapseVideo 1 · HERO13 Black · `subscription_type: s2gp`). Raw output in
`docs/probe-results.json` and `docs/probe-results-followup.json`.

| # | Question | Answer |
| --- | --- | --- |
| U1 | Bearer vs Cookie auth | **Both work.** `Authorization: Bearer` returns `200` ⇒ the OAuth refresh loop in §5.1 is viable and Playwright stays a one-time bootstrap. |
| U5 | Which endpoint lists albums? | **`/media/items?type=collection`.** `/collections` is the share-link system and returned `total_items: 0` against 5 real albums. Full rewrite in §7.4. |
| U7 | Is `order_by` descending? | **Yes, newest-first**, for both `created_at` and `captured_at`. Incremental sync via watermark + early-stop is safe. |
| U8 | Server-side upload-date filter? | **Yes — `created_range` and `updated_range` are real.** One-day narrowing cut 212 → 55 while the `zzz_range` control stayed 212. The plan previously assumed client-side only. |
| U9 | Do Photos expose `variations[]`? | **Yes** — `label: source`, 5568×4872 jpg, and `files[0]` matches those dimensions. Unlike video, a photo's `files[0]` is *not* a proxy. Prefer `variations[source]` uniformly. |
| U12 | `per_page` ceiling | Not a ceiling — **an intermittent truncation bug**. `per_page=100` returned 12 rows in one run and a full 100 minutes later. Use `per_page=50` + completeness assertions (§2.4). |
| U13 | Unknown `fields`/`type`/`state` values | **Silently ignored**, `200`, empty `_embedded.errors`. A forward-compatible field superset is safe — but a typo'd `type=` filter silently returns *everything*, so validate enum values client-side. |
| U14 | `captured_range` semantics | A zero-width range returns 0; `T00:00:00 → T23:59:59.999` works. **A malformed value returns `500`, not `400`** — validate client-side. |
| U16 | Signed CDN URL TTL | **3599 s confirmed** on this account. CloudFront-style `Expires`/`Signature`/`Key-Pair-Id`; `Accept-Ranges: bytes`; `x-amz-storage-class: GLACIER_IR`; `Content-Type: binary/octet-stream` (useless — derive MIME from the filename). |

**Bonus findings not previously in the plan:**

- **The default `/media/search` row carries ~70 fields**, including `available_labels`,
  `upload_completed_at`, `submitted_at`, `reprocessed_at`, `expires_at`, `location`,
  `location_name`, `mce_subtype`, `item_durations`, `subscription_type`, `revision_number`.
  Several are directly useful and none were in the original field list.
- **`available_labels` is a superset of `variations[]` labels** — enables a zero-extra-request
  pre-flight (§7.5).
- **`/media/items` returns a bare `{items, _pages}` envelope**, *not* `_embedded` — a shared
  response parser will break on it.
- **Variations carry `video_codec`** and confirm **no `size`/`file_size` field** (research correct).
- **Live confirmation of the two dangerous traps:** for a real Video, `variations[0]` was
  `edit_proxy` at 720p, and `files[0]` was **1280×720** while `source` was 3840×2160. Taking
  either naively would have silently uploaded a 720p re-encode.

### ⚠️ Cannot be settled from this account — code defensively

This library contains no chaptered videos (`item_count > 1` is 0 across all 212), no `.360`
media, and no Burst or TimeLapse. These remain **unverified assumptions from source-code
research**, and the affected code paths must be written defensively and logged loudly the first
time they are hit:

| # | Question | Handling |
| --- | --- | --- |
| U10 | How does `.360` present in `type` / `Content-Disposition`? | Skip on `file_extension == "360"`; log the full manifest if one is ever seen. |
| U11 | Does a `concat` variation exist for every chaptered medium? | `--chapters=concat` must verify `concat` is present and fall back to `split` if not — never assume. |
| U11b | Are chapters really N `source` variations keyed by `item_number`? | Every observed variation had `item_number: null` (all single-chapter). The composite PK in §6 stays — it is correct either way and costs nothing. |

### ✅ Google-side — settled by the protocol suite, 2026-08-23

Run against a throwaway account with Project A published to **Production, unverified**.
Raw output: `docs/probe-results-google.json`.

| # | Question | Answer |
| --- | --- | --- |
| **U20** | Does `appendonly` work from an unverified Production client? | ✅ **Yes.** Upload `200`, `batchCreate` `200`, `code 0 Success`. The *"requires verification"* banner is advisory and **does not gate API access**. §5.2 is validated. |
| **U19** | Publish without owning the domain? | ✅ Yes — field presence only (§5.3) |
| **U22** | Is `X-Goog-Upload-Raw-Size` mandatory? | ❌ **No.** Sessions opened with it omitted, zeroed, and aliased. *Caveat: only session opening was tested* — keep the GoPro `HEAD` until a full undeclared-size upload is proven. |
| **U21** | Does deduped content join a second album? | ✅ **Yes.** Same `mediaItem.id`, verified present in **both** albums. First `fileName` wins. |
| — | Chunk granularity | Always `262144`, invariant across 1 MB / 200 MB / 5 GB and jpeg / mp4 |
| — | Protocol violations | **All `400`**, no status header. Bad offset, replayed offset, misalignment, unknown session — indistinguishable by code. Session survives; disambiguate with `query` (§7.1) |
| — | Replay an committed offset | ❌ **Rejected `400` — not idempotent.** Always `query` then resume; never blindly re-send |
| — | Partial batch failure | ⚠️ Returned **HTTP `200`**, not `207`, with per-item `0 / 3 / 0`. Never trust the HTTP status |
| — | Oversized `fileName` | ⚠️ **Batch-level `400`; all items lost.** >255 chars kills the whole call |
| — | `albums.list` | Returns app-created albums with `isWriteable: true` and live counts |

✅ **U4 — SETTLED, favourably.** A differential test of 32 uploads-endpoint requests with zero
Library API calls left the daily counter unchanged at 12. **Upload bytes are quota-free**, so
chunked uploads with granular resume are viable. §7.3 rewritten; risk R2 closed.

**⏳ U18 — day-8 refresh survival.** Both clocks started 2026-08-23: Project A (Production)
13:22:42 UTC, Project B (Testing control) 13:27:30 UTC. **Re-check on or after 2026-08-31**
with `python3 tools/probe_google.py --refresh-check`. Project A must survive; Project B must die.

**⏳ U17 — video size cap** (10 GB vs 20 GB). Deferred: settling it means uploading ~20 GB of
synthetic video. Cheap mitigation already in the plan — gate on `HEAD` `Content-Length` and
handle the failure gracefully rather than trusting either number.

### Not probed deliberately

- **Authenticated GoPro rate limits (U15).** Settling this needs a 200-request burst plus parallel
  workers against a real account. On an undocumented API with real credentials that is not worth
  the flagging risk. Self-throttle conservatively and tune empirically instead.
- **U2/U3 (password grant, token lifetime)** require submitting an account password.
- **U6 (Quik-app albums)** needs a manual mobile-app step. Partially mooted: `/media/items`
  is the album system regardless of which client created the album.

---

## 12. Milestones

| # | Deliverable | Status |
| --- | --- | --- |
| M0 | Monorepo scaffold, TS config, license, docs | ✅ done |
| M0.5 | §11 research + live probe | ✅ **complete** — 9 of 11 live questions settled; 3 undecidable on this account |
| M1 | GoPro auth: Playwright bootstrap + OAuth refresh + keychain | next |
| M2 | Library scan (page-completeness retry), SQLite, `ls`/`albums`/filters | |
| M3 | Google BYO-OAuth wizard + loopback/PKCE + **U4/U18–U22 probes** | ✅ protocol suite done — U4 (dashboard) + U18 (day 8) pending |
| M4 | **Streaming engine** — single-request upload, mid-file re-resolve, resume | |
| M5 | Batching, concurrency, albums, pre-flight, verification, chapters | |
| M6 | Docker image | |
| M7 | Web UI + cosmic theme | |
| M8 | Public release: docs, disclaimers, published package | |

---

## 12.5 Acceptance test — agreed scope

The first real end-to-end transfer is deliberately narrow, so a failure is diagnosable and the
blast radius is small. **This is a test scope, not a product constraint** — the engine supports
arbitrary filters; this is simply what we validate against first.

| | |
| --- | --- |
| **Source** | GoPro media captured **2026-01-30** and **2026-01-31** |
| **Filter** | `captured_range=2026-01-30T00:00:00.000Z,2026-01-31T23:59:59.999Z` |
| **Variant** | `source` only — never a proxy |
| **Destination** | A **new** Google Photos album created by go2cloud |
| **Account** | Decided at run time: throwaway for a rehearsal, real account for the live run |

**Why this window.** It is real footage rather than synthetic, small enough to complete in one
sitting, and large enough to exercise multi-file concurrency. Probe data shows this period is
populated (`captured_at` values on 2026-01-30T21:08 and 2026-01-31T22:26–22:35 were sampled).

**What it must demonstrate:**

1. Every item in the window is discovered — with the page-completeness assertion active (§2.4)
2. `source` is selected every time, never `files[0]` or `variations[0]` (§7.5)
3. Zero disk usage beyond the bounded in-flight buffer
4. Capture dates in Google Photos match the GoPro capture dates, not the upload date (§2.5.1)
5. A mid-transfer interrupt resumes without re-sending completed bytes (§7.2)
6. A re-run transfers nothing new — idempotency via the state DB (§6)

**Pre-flight must be reviewed before the live run**, since Google Photos cannot delete anything
that goes wrong (§2.3).

---

## 13. Future work — including a production path

### Verified shared OAuth client — **cheaper than first assessed** ⚠️

The original plan dismissed this as requiring "a paid annual CASA security assessment."
**That was wrong** — CASA applies only to *restricted* scopes, and Photos scopes are *sensitive*.
The sensitive path is roughly **10 business days, no assessor, no recurring fee**, requiring a
verified domain, a privacy policy, and a demo video.

This would remove per-user Google Cloud setup entirely, making go2cloud a `npx` one-liner.

⚠️ **Promoted from "future" to a v1.0 goal by the U19 finding (§5.3).** Since publishing now
demonstrably requires a homepage and privacy-policy URL that most users cannot supply, BYO-only
means most users are stuck re-authenticating weekly forever. A single maintainer-side verification
fixes that for everyone. Requirements: a verified domain, a published privacy policy
(`PRIVACY.md` is written), and a demo video.

The BYO path stays supported regardless, since it keeps each user's data inside their own project
and is the right default for the privacy-conscious.

✅ **CASA definitively ruled out (2026-08-23).** The console's own classification tables place
`appendonly` under *sensitive* and `appcreateddata` under *non-sensitive*, with nothing under
*restricted*. CASA applies only to restricted scopes, so the verified-client path costs time
(~10 business days) and a demo video — **no assessor and no recurring fee**.

*(For reference: CASA self-scan was discontinued in 2024 and now requires a paid third-party
Letter of Validation at roughly $540–3,000/app/year — but that is not the path Photos is on.)*

### Other candidates

- **`--chapters=concat` promoted to default**, if §11 U11 shows `concat` is universally present
  and metadata-faithful.
- **Metadata repair** for proxy variants lacking creation timestamps — note that a stream-copy
  remux can rescue a rejected container at no transcode cost, but changes the bytes and defeats
  Google's dedupe.
- **Additional destinations** — Google Drive, Immich, S3.
- **Incremental sync daemon** using `created_at` watermarks (gated on U7).
- **Public-share CI fixtures.** Publicly-shared GoPro media needs no auth at all, giving a
  zero-credential end-to-end test fixture for the whole download→upload pipeline.

**Permanently out of scope:** deleting or modifying anything in GoPro Cloud.

---

## 14. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Signed CDN URL expires mid-file (1 h vs ~67 min for a 20 GB clip) | **High** | Pre-emptive re-resolve at T−60s + `403` recovery (§7.2) |
| ~~R2~~ | ~~Chunk `POST`s may each consume daily quota~~ **Resolved** — U4 proved upload traffic is quota-free | — | Closed. Chunked mode is now the default above 256 MB (§7.3) |
| R3 | Chapters 2..N silently dropped by a media-id-keyed model | **High** | Composite PK (§6) — was a data-loss bug |
| R4 | `.LRV`/`.THM` fail *silently by succeeding*, flooding the library | **High** | Selection-layer filter + extension denylist (§7.5) |
| R5 | **`/media/search` silently returns short pages** — reproduced live: 12 of 212 rows with a `200` and coherent `_pages` | **Critical** | `per_page=50` + per-page and whole-walk completeness assertions; refuse to proceed on a short walk (§2.4) |
| R6 | Doomed uploads cost full bandwidth before rejection | Medium | Aggressive pre-filter; pre-flight lists skips with reasons |
| R7 | Photos is not a fidelity-preserving backup | Medium | Never claim "backup" in the README; Takeout is the only verification |
| R8 | **No undo** — the API cannot delete items or albums | Medium | Explicit cancellation semantics; pre-flight confirmation |
| R9 | Undocumented per-minute Google write limit | Medium | Pace `batchCreate`; treat repeated `500`s as reduce-concurrency |
| R10 | Video cap ambiguity, 10 GB vs 20 GB | Medium | Gate on `HEAD` `Content-Length`; handle failure gracefully |
| R11 | OAuth client auto-deleted at 6 months; 100-token rollover | Medium | Distinct `deleted_client` path; never re-consent gratuitously |
| R12 | GoPro `429` may carry no `Retry-After` | Low | Always keep the exponential fallback |
| R13 | ~~`/collections` may not enumerate albums~~ **Resolved** — albums are `/media/items?type=collection`; `/collections` is share-links | — | Closed by probe (§7.4) |
| R14 | Album membership ordering is uncontrollable | Low | Single-pass pagination; assume no cross-run stability |
| R18 | A malformed `captured_range`/`created_range` returns `500`, not `400` | Low | Validate range syntax client-side; do not classify every `500` as transient |
| R19 | A typo'd `type=` or `processing_states=` filter is silently ignored and returns **everything** | Medium | Validate enum values client-side before sending — the API will not tell you |
| R15 | CDN objects are `GLACIER_IR` — cold first-byte latency unmeasured | Low | Generous first-byte timeout; slow start ≠ failure |
| R16 | GoPro changes undocumented endpoints | High | Thin client layer, schema validation, `410` deprecation canary |
| R17 | GoPro ToS enforcement | Medium | Own-account, read-only, rate-limited, no delete, prominent disclaimer |

---

## 15. Sources

Google: [API updates](https://developers.google.com/photos/support/updates) ·
[scopes](https://developers.google.com/photos/overview/authorization) ·
[upload guide](https://developers.google.com/photos/library/guides/upload-media) ·
[limits & quotas](https://developers.google.com/photos/overview/api-limits-quotas) ·
[restricted-scope list](https://support.google.com/cloud/answer/13464325) ·
[sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)

GoPro (unofficial): [gpcd](https://github.com/mvisonneau/gpcd) ·
[gopro-plus](https://github.com/itsankoff/gopro-plus) ·
[gopro-api](https://himewel.github.io/gopro-api/main/getting-started/) ·
[media-library-verifier](https://github.com/legosx/gopro-media-library-verifier) ·
[Terms of Use](https://gopro.com/en/us/legal/terms)

Precedent: [Home Assistant Google Photos](https://www.home-assistant.io/integrations/google_photos/) ·
[rclone Google Photos](https://rclone.org/googlephotos/)
