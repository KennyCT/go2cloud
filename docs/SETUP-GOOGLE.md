# Google Cloud setup — for the protocol probes (M3 prerequisite)

**Time: ~10 minutes.** Do this now even though M3 is weeks away — **step 7 starts an 8-day clock**
that is the single longest item on the critical path.

You need **two** Google Cloud projects. The second one exists purely as a scientific control: if
the test project's refresh token still works on day 8, that only proves something if a
Testing-mode project with identical scopes *failed* on day 8.

> **Use a throwaway Google account.** Test uploads **cannot be deleted through the API** — the
> Google Photos API has no delete capability at all. Deliberately malformed files, oversized-video
> probes and duplicate-detection tests would land in your real 2 TB library permanently, removable
> only by hand in the Photos app. A free spare account with its 15 GB is plenty for the probes.

Console navigation changed in 2025. The old "OAuth consent screen" page is now split across
**Google Auth platform → Branding / Audience / Data Access / Clients**.

---

## Project A — the test project

### 1. Create the project

1. Sign in to <https://console.cloud.google.com> **as the throwaway account**
2. Project dropdown (top bar) → **New project**
3. Name: `go2cloud-test` → **Create**, then make sure it's selected

### 2. Enable the Photos Library API

1. **APIs & Services → Library**
2. Search `Photos Library API` → open it → **Enable**

> Enable the **Photos Library API**, not "Photos Picker API". Picker is read-only selection and
> cannot upload.

### 3. Branding

**Google Auth platform → Branding**

- App name: `go2cloud`
- User support email: your throwaway address
- Developer contact email: same
- **Application home page:** `https://github.com/KennyCT/go2cloud`
- **Application privacy policy link:** `https://github.com/KennyCT/go2cloud/blob/main/PRIVACY.md`
- Terms of service: leave empty (not required)

**Save.**

> **Why these are mandatory.** Publishing an External app to Production is refused without app
> name, support email, homepage URL **and** privacy policy URL — confirmed live on 2026-08-23:
> *"Valid app name, support email, homepage url, and privacy policy url are required for switching
> the app to external production mode."*
>
> Both URLs are on `github.com`, satisfying Google's same-domain guidance for the privacy policy.
> Domain **ownership** is a requirement of *submitting for verification*, which go2cloud does not
> do — publishing unverified should only validate that the fields are present and resolve. If the
> console rejects them anyway, that is a real finding: report it and fall back to Testing mode.

### 4. Audience — set External

**Google Auth platform → Audience** → User type **External** → **Save**.

Leave it in *Testing* for now; step 7 flips it.

### 5. Data Access — add the scopes 📋 *this is a probe*

**Google Auth platform → Data Access → Add or remove scopes**

Filter for `photoslibrary` and tick:

```
https://www.googleapis.com/auth/photoslibrary.appendonly
https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata
```

**Update**, then **Save**.

> ✅ **Confirmed 2026-08-23.** The console sorts these into `appendonly` → **sensitive** and
> `appcreateddata` → **non-sensitive**, with the *restricted* table empty. That rules out CASA,
> which applies only to restricted scopes.

### 6. Create the OAuth client

**Google Auth platform → Clients → Create client**

- Application type: **Desktop app** ← *not* "Web application", whatever the Photos docs say.
  Desktop needs no registered redirect URI and works with any ephemeral loopback port.
- Name: `go2cloud-cli` → **Create**

**A dialog appears with the client ID and secret. Click "Download JSON" immediately.**
Google masks client secrets permanently after creation — if you close this dialog without
downloading, you must delete the client and start over.

Save it where the probe expects. **Set `PROJ` to match the project you are currently in** —
`test` for Project A, `control` for Project B:

```bash
PROJ=test          # ← change to "control" when doing Project B
mkdir -p ~/.go2cloud && chmod 700 ~/.go2cloud
mv ~/Downloads/client_secret_*.json ~/.go2cloud/google_client_$PROJ.json
chmod 600 ~/.go2cloud/google_client_$PROJ.json
ls -l ~/.go2cloud/google_client_*.json     # verify BOTH exist before continuing
```

> ⚠️ **Do not paste this block unchanged for Project B.** Overwriting
> `google_client_test.json` destroys Project A's `client_secret`, and Google **masks client
> secrets permanently after creation** — there is no way to recover it. The only fix is to
> create a brand-new OAuth client in Project A. Any refresh token minted against the lost
> client also becomes permanently unusable.

### 7. Publish to Production ⏱️ *starts the 8-day clock* 📋 *this is a probe*

**Google Auth platform → Audience → Publish app** → confirm.

> ✅ **Confirmed 2026-08-23: this works.** With the four Branding fields populated the app
> publishes to Production even though the URLs are on a domain you do not own — the console checks
> field presence, not ownership.
>
> Afterwards a banner appears: *"Your app requires verification… please submit your app for
> review."* **Ignore it.** It is the standard unverified + sensitive-scope nag, not a block. Do
> **not** submit for review — verification is the §13 future path, not this one.

Publishing **before** first consent matters: a token minted while in Testing may keep its 7-day
fuse even after publishing (U27). We mint tokens only after this step.

---

## Project B — the control project

Repeat steps 1–6 with:

- Project name `go2cloud-control`
- Client name `go2cloud-control-cli`
- **Step 6: set `PROJ=control`** so the JSON lands at `~/.go2cloud/google_client_control.json`
  and does **not** overwrite Project A's

### 7b. Do NOT publish — add yourself as a test user instead

**This is a required step, not an optional one.** A Testing-mode app rejects everyone who is not
on its test-user list:

1. **Google Auth platform → Audience**
2. Leave publishing status as **Testing** — do *not* click Publish app
3. Under **Test users** → **+ Add users** → enter the email of the account you will sign in with
4. **Save**

> Skipping this produces:
> *"go2cloud has not completed the Google verification process. The app is currently being tested,
> and can only be accessed by developer-approved testers. … Error 403: access_denied"*
>
> If your browser is signed into several Google accounts, make sure the address you add matches
> the one the consent screen actually signs in as.

This project's refresh token **must** die on day 8. If it survives, the whole experiment is
invalid and we learn nothing from Project A.

---

## What happens next

Once both JSON files are in place, tell me and I'll run:

```bash
python3 tools/probe_google.py --auth        # consent once per project, mint refresh tokens
python3 tools/probe_google.py --suite       # the full protocol suite
```

The consent screen will show **"Google hasn't verified this app."** That is expected and correct —
it's your own project. Click **Advanced → Go to go2cloud (unsafe)**.

Then on day 8 I re-run one command against both projects and U18 is settled.

---

## Checklist

- [x] Throwaway Google account created
- [x] `go2cloud-test`: Photos Library API enabled
- [x] `go2cloud-test`: branding saved **with the two github.com URLs**
- [x] `go2cloud-test`: two scopes added (sensitive / non-sensitive — no CASA)
- [x] `go2cloud-test`: Desktop client created, JSON downloaded → `~/.go2cloud/google_client_test.json`
- [x] `go2cloud-test`: **published to Production** ✅ (verification banner is expected; ignore it)
- [ ] `go2cloud-control`: same, **left in Testing**, self added as test user
      → `~/.go2cloud/google_client_control.json`
