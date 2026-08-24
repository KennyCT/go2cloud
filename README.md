# go2cloud

**Move footage that's already in GoPro Cloud into Google Photos — streamed, never staged on disk.**

[![Status](https://img.shields.io/badge/status-in%20development-orange)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)]()

---

## What this is for

Your clips are already in GoPro Cloud — GoPro Premium's auto-upload puts them there in the
background. Getting them into Google Photos normally means downloading gigabytes to your laptop,
waiting, uploading the same bytes back, waiting again, then deleting the local copy.

go2cloud collapses that into one streamed pass: **GoPro CDN → memory → Google Photos** in ~64 MB
windows. The bytes still travel down and back up — no API on either side can avoid that — but
they never touch disk, the two legs overlap instead of running one after the other, and the whole
thing is unattended. It transfers files in parallel and resumes after a crash, a closed laptop, or
a dead Wi-Fi connection — large files continue from the last committed byte rather than starting
again.

| Use it when | Why |
| --- | --- |
| The footage is already in GoPro Cloud | The card has been wiped, reused, or isn't to hand. This is the main case. |
| You have no card reader | No card slot, no USB-C adapter, no phone dongle. |
| You're moving a lot at once | Date-range and album selection, resume after an interruption, and skipping already-transferred items on a re-run are all work you'd otherwise do by hand. |

**Don't use it when the footage is still on the card and you have a reader.** Uploading straight
from the card — with a card reader, a phone adapter, or the Google Photos desktop uploader —
avoids the download leg entirely, so it's simpler and faster. go2cloud is for footage that now
only lives in the cloud.

---

## ⚠️ Read this before you start

These are real constraints, not caveats we're working around. They come from what the GoPro and
Google Photos APIs actually permit — see [`docs/PLAN.md`](docs/PLAN.md) for the evidence.

**This is not a true cloud-to-cloud transfer, because no such thing exists.** The Google Photos
API has no import-from-URL capability — it only accepts raw bytes. So every byte is pulled down
from GoPro and pushed back up to Google through your machine. go2cloud removes the *disk* cost
and the *babysitting*, and overlaps the two legs so the wall-clock is roughly the upload alone —
but it cannot remove the traffic. Your **upload** speed is the floor: 200 GB at 40 Mbps is about
11 hours no matter how good the code is. The difference is that they are unattended hours.

**Every upload counts against your Google storage, at original quality.** The API offers no
Storage Saver option. A 500 GB library needs a 2 TB Google One plan. go2cloud shows you the
projected storage impact and makes you confirm before it moves a single byte.

**You cannot upload into an album you made in the Google Photos app.** Since March 2025 the API
can only touch albums *it* created. go2cloud can create albums and add to albums it created
earlier — but an album you made by hand in Google Photos is permanently off-limits to any
third-party tool. This is a Google restriction with no workaround.

**There is no undo.** The Google Photos API cannot delete media items or albums. If you transfer
something by mistake, you must remove it manually in the Google Photos app. Take the pre-flight
confirmation seriously.

**This is a migration tool, not a backup tool.** Google Photos re-compresses video on the way
back out through the API and strips EXIF location data. If you need guaranteed byte-for-byte
recovery, keep your originals or use Google Takeout.

**GoPro has no public API.** go2cloud uses the same undocumented endpoints as GoPro's own web
media library. See [Legal & disclaimer](#legal--disclaimer).

---

## Project status

🚧 **Working, but not yet packaged for other people.** The pipeline has moved 65 GB of real
footage end to end; what remains is distribution and polish.

| Milestone | What it delivers | Status |
| --- | --- | --- |
| M0 | Repo scaffold, toolchain, license | ✅ Done |
| M0.5 | API research + live probes | ✅ Done — 24 of 26 questions settled |
| M1 | GoPro auth (browser login, OS keychain) | ✅ Done |
| M2 | Library scan, filtering, album listing | ✅ Done |
| M3 | Google OAuth setup + multi-account profiles | ✅ Done |
| M4 | Streaming transfer engine | ✅ Done |
| M5 | Batching, pre-flight, resume, verify, chapters | ✅ Done |
| **M7** | **Web UI (cosmic theme)** | 🛠 **In progress** — dashboard works; selection and history still to come |
| M6 | Docker image for unattended runs | ⏳ Next |
| M8 | Public release: npm package, docs, CI | ⏳ |

**Proven in real use:** a single run moved **61 items / 65 GB in 4h 14m** with zero failures,
capture dates preserved exactly, and three files over 5 GB rescued mid-upload when their GoPro
download URLs expired. **39 tests** cover the paths that fail silently rather than loudly.

Two questions remain open, both tracked in [`docs/PLAN.md` §11](docs/PLAN.md#11-live-probe-checklist):
whether Google refresh tokens survive past day 7 for an unverified Production app (verdict due
31 August 2026), and the real video size cap.

## Requirements

- **Node.js ≥ 22.5** (repo pins 24 LTS via [`fnm`](https://github.com/Schniz/fnm) and `.node-version`)
- **A GoPro Premium or Premium+ subscription** with media in GoPro Cloud
- **A Google account** with enough storage headroom for what you're transferring
- **A Google Cloud project** — free, and the setup wizard walks you through it (~5 minutes)
- Python 3.9+ *(only for the probe tool; the app itself needs no Python)*

---

## How it works

```
   GoPro Cloud                  go2cloud                    Google Photos
  ┌────────────┐          ┌───────────────────┐           ┌──────────────┐
  │ /media/    │  list    │  scan → SQLite    │           │              │
  │  search    │─────────▶│  state + planning │           │              │
  └────────────┘          └─────────┬─────────┘           │              │
  ┌────────────┐                    │ pre-flight gate     │              │
  │ /media/{id}│  resolve           ▼ (you confirm)       │              │
  │  /download │─────────▶┌───────────────────┐  resumable│              │
  └────────────┘          │  streaming engine │──────────▶│  /v1/uploads │
  ┌────────────┐  ranged  │  ~64 MB in flight │  upload   │  batchCreate │
  │  CloudFront│─────────▶│  no disk writes   │           │              │
  └────────────┘   GET    └───────────────────┘           └──────────────┘
```

**Key design points**, each forced by something the APIs actually do:

- **Nothing touches disk.** One bounded buffer per in-flight file; peak RAM is
  `concurrency × chunk_size`, independent of library size.
- **Signed GoPro URLs expire after exactly 3600 seconds.** A 20 GB clip can take longer than
  that to upload, so the engine re-resolves the download URL mid-file and continues from the
  current byte offset.
- **Originals only.** GoPro's `files[]` array is a 1080p proxy — the real file is the variation
  labelled `source`. Uploading the proxy would silently lose both quality and capture metadata.
- **Chapters are handled correctly.** A long recording is *one* GoPro media id containing N
  chapter files. State is keyed on `(media_id, item_number)` so nothing is dropped, and
  `--chapters=concat` can instead upload GoPro's server-stitched version as one continuous clip.
- **Resume is real, with one caveat.** Google's resumable sessions live 7 days and their committed
  offset is authoritative, so an interrupted upload of a large file continues from where it stopped
  rather than restarting. Files under 256 MB are sent in a single request and simply restart, which
  costs seconds. Completed files are never re-sent either way.
- **Idempotent re-runs.** A local SQLite map of `(media_id, item_number) → google_media_item_id`
  means running go2cloud twice transfers only what's new.

---

## Installation

> Not published yet — these are the intended commands.

```bash
npm install -g go2cloud     # or: npx go2cloud
```

**From source:**

```bash
git clone https://github.com/KennyCT/go2cloud.git
cd go2cloud
fnm use && corepack enable   # Node 24 + pnpm
pnpm install && pnpm build
```

---

## Setup

### 1. Connect GoPro

```bash
go2cloud auth gopro
```

Opens GoPro's real login page in an isolated browser window. **You** log in — including 2FA.
Your password never passes through go2cloud; only the resulting token is captured, and it goes
straight into your OS keychain. go2cloud then refreshes that token automatically, so this is a
one-time step.

### 2. Connect Google Photos

```bash
go2cloud auth google --setup
```

Google requires each user to bring their own OAuth client for Photos access. The wizard walks
you through it, but the short version:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Photos Library API**
3. Configure the OAuth consent screen, **User type: External**
4. **Set Publishing status to "In production."** ← *Do not skip this.* Left in "Testing", Google
   expires your credentials every 7 days and you'll re-authenticate weekly forever.
5. Create credentials → OAuth client ID → **Application type: Desktop app**
6. **Click "Download JSON" immediately** — Google only shows the client secret once
7. Run `go2cloud auth google --setup` and point it at that file

You'll see a *"Google hasn't verified this app"* warning. That's expected — the app is **your
own project**, used only by you. Click **Advanced → Go to go2cloud**.

### Using more than one Google account

You only ever create **one** Cloud project. The OAuth client identifies the *app*, not the
account, so any Google account can connect to the same client:

```bash
go2cloud --profile personal auth google     # consent as a second account
go2cloud --profile personal transfer --from 2024-06-01 --new-album "Summer"
```

Each profile keeps its own tokens and its own transfer database, so "already transferred" is
tracked per destination. Omit `--profile` and you get the `default` one.

> **Why bring your own client?** Your media never passes through a shared credential, and your
> Google project is yours alone. A verified shared client is
> [planned](docs/PLAN.md#13-future-work--including-a-production-path) to remove this step later.

---

## Usage

```bash
go2cloud scan                      # index your GoPro library into local state
go2cloud ls --from 2024-06-01      # browse what's there (capture date)
go2cloud ls --uploaded-from 2024-06-01   # or filter by upload date
go2cloud albums                    # list your GoPro albums
```

Both date axes filter server-side, so narrowing a large library is cheap.

### Transferring

```bash
# Everything from a date range, into a new album
go2cloud transfer --from 2024-06-01 --to 2024-08-31 --new-album "Summer 2024"

# One GoPro album into Google Photos
go2cloud transfer --album "Iceland" --new-album "Iceland"

# Videos only, straight to the library root
go2cloud transfer --type Video

# See exactly what would happen, without doing it
go2cloud transfer --from 2024-06-01 --dry-run
```

Every transfer stops at a **pre-flight gate** first:

```
  Pre-flight
  ─────────────────────────────────────────────
  Items to transfer      1,247  (1,193 media + 54 chapters)
  Total size             487.3 GB
  Estimated duration     ~27h 15m  at 40 Mbps
  Google storage impact  487.3 GB  → 1.51 TB of 2 TB used
  Destination            new album "Summer 2024"

  Skipping 8 items:
    6 × .360 (Google Photos cannot read this format)
    2 × Quik edit projects (not real media)

  Continue? [y/N]
```

### Resuming and checking

```bash
go2cloud status     # what's done, in flight, failed
go2cloud resume     # pick up an interrupted run
go2cloud verify     # confirm items landed in Google Photos
```

### Useful flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--concurrency N` | `3` | Files in flight. Raise only if your upload link is fast. |
| `--chapters split\|concat` | `split` | `concat` uploads GoPro's stitched version as one clip. |
| `--variant source\|<label>` | `source` | Anything but `source` loses quality and capture dates. |
| `--chunk-policy single\|chunked` | `single` | Single-request uploads use far less API quota. |
| `--dry-run` | off | Plan and print; transfer nothing. |

### Web UI

```bash
go2cloud ui                      # → http://127.0.0.1:4173
go2cloud --profile real ui       # a specific connected account
```

The same engine behind a dashboard: connection status, date/type/album filters, a scannable
media table with a live size and duration estimate, destination picker, and per-file transfer
progress streamed over server-sent events.

It binds to **loopback only** and holds no credentials of its own — authentication still happens
in the terminal, through the OS keychain. There is no login screen because there is nothing on
the network to protect.

---

## Running the probe

The only part you can run today. GoPro documents nothing, so this asks the API directly and
writes down the answers.

**GoPro** — read-only, safe to run against your real account:

```bash
python3 tools/probe_gopro.py --dry-run   # review every request first
python3 tools/probe_gopro.py             # main probe   (~39 requests)
python3 tools/probe_gopro_followup.py    # follow-up    (~24 requests)
```

These issue only `GET` and `HEAD` requests — no bytes downloaded, nothing created or modified.
Your token is read from `~/.go2cloud/probe_token`, is never printed or written to any output
file, and signed CDN credentials are stripped from the results.

**Google** — ⚠️ **this one writes.** It uploads media and creates albums, and the Google Photos
API cannot delete them, so point it at a throwaway account:

```bash
python3 tools/probe_google.py --auth --project test
python3 tools/probe_google.py --suite
python3 tools/probe_google.py --refresh-check   # on day 8
```

Setup: [`docs/SETUP-GOOGLE.md`](docs/SETUP-GOOGLE.md) · GoPro details:
[`docs/PROBE.md`](docs/PROBE.md) · Findings:
[`docs/PLAN.md` §11](docs/PLAN.md#11-live-probe-checklist).

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401` from GoPro | Session expired. Run `go2cloud auth gopro` again. GoPro publishes no session lifetime and ends them unpredictably — observed lifetimes are hours, so expect to sign in more than once a day during long sessions. |
| `406` from GoPro | Missing vendor `Accept` header — a bug; please file an issue. |
| `410` from GoPro | GoPro changed their API version. **Please open an issue** — this is the deprecation canary. |
| `invalid_grant` from Google after ~7 days | Your OAuth app is still in "Testing". Set Publishing status to **In production** (setup step 4). |
| `deleted_client` from Google | The OAuth client was auto-deleted after 6 months idle. Restorable within 30 days in the Console. |
| Storage-full error mid-run | Google One quota exhausted. Free space or upgrade, then `go2cloud resume`. |
| Transfer slower than expected | Your upload bandwidth is the floor. Check with a speed test — this is usually not go2cloud. |
| Items uploaded with today's date | The variant lacked embedded capture metadata. Use `--variant source`. Google does not allow dates to be set via API. |

---

## Security

- **Tokens live in your OS keychain** (macOS Keychain / libsecret / Windows Credential Manager),
  never in plaintext files and never in this repo.
- **Your GoPro password never reaches go2cloud.** Login happens on GoPro's own page in an
  isolated browser context that is destroyed after the token is captured.
- **Your Google credentials stay in your own Google Cloud project.** No shared client, no
  intermediary server.
- **Nothing leaves your machine** except to GoPro and Google directly. No telemetry, no
  analytics, no phone-home.
- **All state lives in `~/.go2cloud/`**, outside the repo.
- go2cloud **never deletes anything**, on either side.

Found a security issue? Please open a GitHub issue.

---

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm typecheck
pnpm test
```

```
packages/core/   engine — GoPro client, Google client, transfer pipeline, SQLite state
packages/cli/    command-line interface
packages/web/    React dashboard
tools/           probe_gopro.py — read-only API probe
docs/            PLAN.md (design + evidence) · PROBE.md
```

[`docs/PLAN.md`](docs/PLAN.md) is the design document and the reasoning behind every decision,
including what was tried and rejected. Read it before making architectural changes — much of
what looks arbitrary is a workaround for undocumented API behaviour.

---

## Legal & disclaimer

**go2cloud is not affiliated with, endorsed by, or supported by GoPro or Google.**

GoPro publishes no public API for GoPro Cloud. go2cloud uses the same undocumented endpoints
that GoPro's own web media library uses, accessed with your own credentials, against your own
account, **read-only**. It never deletes or modifies anything in GoPro Cloud.

This carries risks you should understand:

- These endpoints can change or disappear without notice, breaking the tool.
- Automated access may conflict with [GoPro's Terms of Use](https://gopro.com/en/us/legal/terms),
  which permit account suspension at GoPro's discretion.

To keep usage respectful, go2cloud rate-limits itself, identifies itself honestly in its
User-Agent, and never accesses anything but your own media. **Use at your own risk.**

---

## License

[MIT](LICENSE) © 2026 KennyCT
