# Privacy Policy — go2cloud

**Last updated: 23 August 2026**

go2cloud is a free, open-source command-line tool that transfers your own media from GoPro Cloud
into your own Google Photos library. It runs entirely on your own computer.

## The short version

**go2cloud has no servers, no backend, and no operator who can see your data.** It is software you
run yourself. Nothing you do with it is transmitted to the authors, and there is no account to
create, no analytics, and no telemetry of any kind.

## What go2cloud accesses

When you connect your accounts, go2cloud is granted access to:

**GoPro Cloud** — read-only access to your own media library: file listings, metadata (filenames,
capture dates, resolutions, camera model, album membership) and time-limited download links. It
reads only. It never creates, modifies, or deletes anything in GoPro Cloud.

**Google Photos** — via the following OAuth scopes:

| Scope | What it permits |
| --- | --- |
| `photoslibrary.appendonly` | Upload media and create new albums |
| `photoslibrary.readonly.appcreateddata` | Read back **only** the items and albums go2cloud itself created, to confirm uploads succeeded |

go2cloud **cannot read your existing Google Photos library.** The `appcreateddata` scope limits it
to items it uploaded itself. It also cannot delete anything — the Google Photos API provides no
delete capability.

## What go2cloud stores, and where

Everything stays on your computer:

- **Access and refresh tokens** are stored in your operating system's credential manager (macOS
  Keychain, Linux Secret Service, or Windows Credential Manager). They are never written to
  plain-text files and never included in logs.
- **A local SQLite database** in `~/.go2cloud/` holds media metadata and transfer records so that
  interrupted transfers can resume and repeated runs don't upload duplicates.
- **Log files**, if enabled, are written locally with credentials redacted.

You can delete all of it at any time by removing `~/.go2cloud/` and revoking access at
<https://myaccount.google.com/permissions>.

## What go2cloud transmits, and to whom

Only to the two services you connected:

- **api.gopro.com** and GoPro's media CDN — to list and download your own media
- **photoslibrary.googleapis.com** and **oauth2.googleapis.com** — to authenticate and upload

Your media flows directly from GoPro to your computer to Google Photos. It does not pass through
any third party. **No data is sent to the authors of go2cloud or to anyone else.**

## What the authors receive

**Nothing.** There is no telemetry, no crash reporting, no usage analytics, and no phone-home. The
authors of go2cloud have no ability to see your media, your metadata, your tokens, or even whether
you use the software.

If you voluntarily open a GitHub issue, you control entirely what you include in it.

## Your own OAuth credentials

go2cloud asks you to create your own Google Cloud project and OAuth client. This means your Google
API access runs under **your** project, not a shared one belonging to the authors. No credential
controlled by anyone else is involved in your use of the software.

## Data retention

go2cloud retains data only for as long as it exists on your computer. There is no remote copy,
so there is nothing for the authors to retain, disclose, or delete on your behalf.

## Limited Use disclosure

go2cloud's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Specifically, data obtained through Google APIs is used
solely to provide the transfer functionality you invoke, is never sold, is never used for
advertising, and is never transferred to third parties.

## Children

go2cloud is not directed at children under 13 and collects no information from anyone.

## Third-party services

go2cloud interacts with GoPro and Google, each governed by its own policies:

- [GoPro Privacy Policy](https://gopro.com/en/us/legal/privacy-policy)
- [Google Privacy Policy](https://policies.google.com/privacy)

go2cloud is not affiliated with, endorsed by, or supported by either company.

## Changes

Changes to this policy will be published in this file. Its history is publicly visible in the
repository's version control.

## Contact

Open an issue at <https://github.com/KennyCT/go2cloud/issues>.
