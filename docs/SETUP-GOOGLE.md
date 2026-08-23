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
- **Leave the homepage, privacy policy and terms URLs empty.** Whether you can publish without
  them is exactly what we're testing (U19).

**Save.**

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

> 📋 **Tell me what you see.** The scopes get sorted into three labelled tables — *"Your
> non-sensitive scopes"*, *"Your sensitive scopes"*, *"Your restricted scopes"*. **Which table did
> each land in?** This is the only authoritative source for that classification, and the entire
> "no CASA needed" conclusion rests on them being *sensitive* rather than *restricted*. If either
> shows up under **restricted**, tell me before going further — it changes the plan.

### 6. Create the OAuth client

**Google Auth platform → Clients → Create client**

- Application type: **Desktop app** ← *not* "Web application", whatever the Photos docs say.
  Desktop needs no registered redirect URI and works with any ephemeral loopback port.
- Name: `go2cloud-cli` → **Create**

**A dialog appears with the client ID and secret. Click "Download JSON" immediately.**
Google masks client secrets permanently after creation — if you close this dialog without
downloading, you must delete the client and start over.

Save it where the probe expects:

```bash
mkdir -p ~/.go2cloud && chmod 700 ~/.go2cloud
mv ~/Downloads/client_secret_*.json ~/.go2cloud/google_client_test.json
chmod 600 ~/.go2cloud/google_client_test.json
```

### 7. Publish to Production ⏱️ *starts the 8-day clock* 📋 *this is a probe*

**Google Auth platform → Audience → Publish app** → confirm.

> 📋 **Tell me exactly what happens.** Three possible outcomes, and they mean very different things:
> - **It publishes** → status becomes *In production*. This is the outcome the plan assumes.
> - **It demands a homepage / privacy policy URL** → tell me. BYO-Production may be dead, and
>   everyone falls back to weekly re-auth.
> - **It demands verification before allowing the scopes** → tell me. Same fallback.

Publishing **before** first consent matters: a token minted while in Testing may keep its 7-day
fuse even after publishing (U27). We mint tokens only after this step.

---

## Project B — the control project

Repeat steps 1–6 with:

- Project name `go2cloud-control`
- Client name `go2cloud-control-cli`
- Save the JSON as `~/.go2cloud/google_client_control.json`

**Do not publish this one.** Leave it in *Testing* and add your throwaway address under
**Audience → Test users**.

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

- [ ] Throwaway Google account created
- [ ] `go2cloud-test`: Photos Library API enabled
- [ ] `go2cloud-test`: branding saved, **URLs left empty**
- [ ] `go2cloud-test`: two scopes added → **which table did they land in?**
- [ ] `go2cloud-test`: Desktop client created, JSON downloaded → `~/.go2cloud/google_client_test.json`
- [ ] `go2cloud-test`: **published to Production** → what happened?
- [ ] `go2cloud-control`: same, **left in Testing**, self added as test user
      → `~/.go2cloud/google_client_control.json`
