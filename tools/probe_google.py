#!/usr/bin/env python3
"""
go2cloud -- Google Photos API protocol probe (PLAN.md section 11, phases E-G)

Everything go2cloud believes about the Google upload path is read from documentation.
Documentation is exactly what was wrong about scope classification and CASA, so the
protocol gets verified against the live API before the engine is built on it.

WARNING -- THIS PROBE WRITES. Unlike the GoPro probes, this one uploads bytes and
creates media items and albums. The Google Photos API has NO DELETE CAPABILITY, so
everything it creates is permanent in the target library and can only be removed by
hand in the Photos app. Point it at a throwaway account. See docs/SETUP-GOOGLE.md.

Test media is generated in-process: valid JPEGs padded to arbitrary size with COM
(comment) segments, which decoders skip. No ffmpeg, no downloads, no external files.

Standard library only (targets system Python 3.9).

Usage:
    python3 tools/probe_google.py --auth  --project test      # consent once, mint tokens
    python3 tools/probe_google.py --auth  --project control
    python3 tools/probe_google.py --suite                     # full protocol suite
    python3 tools/probe_google.py --refresh-check             # the day-8 U18 verdict
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import OrderedDict
from datetime import datetime, timezone

HOME = os.path.expanduser("~/.go2cloud")
GPH = "https://photoslibrary.googleapis.com"
TOKEN_URL = "https://oauth2.googleapis.com/token"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
SCOPES = [
    "https://www.googleapis.com/auth/photoslibrary.appendonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
]
UA = "go2cloud-probe/0.3 (+https://github.com/KennyCT/go2cloud)"
OUT = "docs/probe-results-google"


# --------------------------------------------------------------------------- #
# Test media generation
# --------------------------------------------------------------------------- #

# A minimal but genuinely valid 1x1 baseline JPEG.
_TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
)


def make_jpeg(target_bytes):
    """A valid JPEG padded to ~target_bytes using COM segments (decoders skip them)."""
    if target_bytes <= len(_TINY_JPEG):
        return _TINY_JPEG
    head, tail = _TINY_JPEG[:2], _TINY_JPEG[2:]  # SOI, rest
    pad_needed = target_bytes - len(_TINY_JPEG)
    chunks = [head]
    while pad_needed > 0:
        # COM segment: FF FE <2-byte length incl. itself> <payload>. Max payload 65533.
        payload = min(pad_needed, 65533)
        chunks.append(b"\xff\xfe" + (payload + 2).to_bytes(2, "big") + b"\x00" * payload)
        pad_needed -= payload + 4
    chunks.append(tail)
    return b"".join(chunks)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def request(url, method="GET", headers=None, body=None, timeout=180):
    req = urllib.request.Request(url, method=method, data=body)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, status, hdrs = r.read(), r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        raw, status, hdrs = e.read(), e.code, dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return {"error": "{}: {}".format(type(e).__name__, e),
                "elapsed_ms": int((time.time() - started) * 1000)}
    text = raw.decode("utf-8", errors="replace")
    parsed = None
    try:
        parsed = json.loads(text)
    except ValueError:
        pass
    return {
        "status": status, "ok": 200 <= status < 300,
        "elapsed_ms": int((time.time() - started) * 1000),
        "goog_headers": {k: v for k, v in hdrs.items() if k.lower().startswith("x-goog")},
        "json": parsed, "text": None if parsed is not None else text[:600],
    }


# --------------------------------------------------------------------------- #
# OAuth (loopback + PKCE)
# --------------------------------------------------------------------------- #

def client_path(project):
    return os.path.join(HOME, "google_client_{}.json".format(project))


def token_path(project):
    return os.path.join(HOME, "google_tokens_{}.json".format(project))


def load_client(project):
    p = client_path(project)
    if not os.path.exists(p):
        raise SystemExit("Missing {}\nSee docs/SETUP-GOOGLE.md".format(p))
    d = json.load(open(p))
    node = d.get("installed") or d.get("web") or d
    return node["client_id"], node["client_secret"]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def do_auth(project):
    cid, csec = load_client(project)
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(24)
    port = free_port()
    redirect = "http://127.0.0.1:{}/".format(port)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            ok = "code" in got and got.get("state") == state
            self.wfile.write(b"<h2>go2cloud: " +
                             (b"authorised. You can close this tab." if ok else b"FAILED") +
                             b"</h2>")

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.handle_request, daemon=True).start()

    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
    })
    print("\nOpening the consent screen for project '{}'.".format(project), file=sys.stderr)
    print("Expect \"Google hasn't verified this app\" -> Advanced -> Go to go2cloud.\n",
          file=sys.stderr)
    print(url + "\n", file=sys.stderr)
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001
        pass

    for _ in range(300):
        if got.get("code") or got.get("error"):
            break
        time.sleep(1)
    srv.server_close()
    if not got.get("code"):
        raise SystemExit("No authorisation code received: {}".format(got or "timeout"))
    if got.get("state") != state:
        raise SystemExit("State mismatch -- aborting.")

    r = request(TOKEN_URL, "POST",
                {"Content-Type": "application/x-www-form-urlencoded"},
                urllib.parse.urlencode({
                    "client_id": cid, "client_secret": csec, "code": got["code"],
                    "code_verifier": verifier, "grant_type": "authorization_code",
                    "redirect_uri": redirect}).encode())
    if not r.get("ok"):
        raise SystemExit("Token exchange failed: {} {}".format(r.get("status"), r.get("json")))
    tok = r["json"]
    tok["obtained_at"] = int(time.time())
    tok["obtained_at_iso"] = datetime.now(timezone.utc).isoformat()
    os.makedirs(HOME, exist_ok=True)
    with open(token_path(project), "w") as fh:
        json.dump(tok, fh, indent=2)
    os.chmod(token_path(project), 0o600)
    print("Saved tokens for '{}'. refresh_token present: {}".format(
        project, bool(tok.get("refresh_token"))), file=sys.stderr)
    print("U18 clock started at {} -- re-check after day 8.".format(tok["obtained_at_iso"]),
          file=sys.stderr)


def refresh(project):
    """Exchange the stored refresh token. Returns (access_token|None, raw_result)."""
    cid, csec = load_client(project)
    p = token_path(project)
    if not os.path.exists(p):
        return None, {"error": "no tokens for " + project}
    tok = json.load(open(p))
    if not tok.get("refresh_token"):
        return None, {"error": "no refresh_token stored"}
    r = request(TOKEN_URL, "POST",
                {"Content-Type": "application/x-www-form-urlencoded"},
                urllib.parse.urlencode({
                    "client_id": cid, "client_secret": csec,
                    "refresh_token": tok["refresh_token"],
                    "grant_type": "refresh_token"}).encode())
    if r.get("ok") and (r.get("json") or {}).get("access_token"):
        return r["json"]["access_token"], r
    return None, r


def auth_header(project="test"):
    at, r = refresh(project)
    if not at:
        raise SystemExit("Could not obtain an access token for '{}': {}".format(
            project, json.dumps(r)[:400]))
    return {"Authorization": "Bearer " + at}


# --------------------------------------------------------------------------- #
# Upload helpers
# --------------------------------------------------------------------------- #

def upload_raw(hdr, data, mime="image/jpeg"):
    """Non-resumable upload. Returns the upload token or an error dict."""
    h = dict(hdr)
    h.update({"Content-type": "application/octet-stream",
              "X-Goog-Upload-Content-Type": mime,
              "X-Goog-Upload-Protocol": "raw"})
    r = request(GPH + "/v1/uploads", "POST", h, data)
    return (r.get("text") or "").strip() if r.get("ok") else None, r


def session_start(hdr, size, mime="image/jpeg", omit_size=False, alias=None):
    h = dict(hdr)
    h.update({"Content-Length": "0",
              "X-Goog-Upload-Command": "start",
              "X-Goog-Upload-Content-Type": mime,
              "X-Goog-Upload-Protocol": "resumable"})
    if not omit_size:
        h["X-Goog-Upload-Raw-Size"] = str(size)
    if alias:
        h[alias] = str(size)
    return request(GPH + "/v1/uploads", "POST", h, b"")


def session_url(r):
    for k, v in (r.get("goog_headers") or {}).items():
        if k.lower() == "x-goog-upload-url":
            return v
    return None


def goog(r, name):
    for k, v in (r.get("goog_headers") or {}).items():
        if k.lower() == name.lower():
            return v
    return None


def chunk_post(hdr, url, data, offset, finalize=False):
    h = dict(hdr)
    h.update({"Content-Length": str(len(data)),
              "X-Goog-Upload-Command": "upload, finalize" if finalize else "upload",
              "X-Goog-Upload-Offset": str(offset)})
    return request(url, "POST", h, data)


def session_query(hdr, url):
    h = dict(hdr)
    h.update({"Content-Length": "0", "X-Goog-Upload-Command": "query"})
    return request(url, "POST", h, b"")


def batch_create(hdr, tokens_names, album_id=None):
    h = dict(hdr)
    h["Content-Type"] = "application/json"
    items = []
    for tk, name in tokens_names:
        smi = {"uploadToken": tk}
        if name:
            smi["fileName"] = name
        items.append({"simpleMediaItem": smi})
    body = {"newMediaItems": items}
    if album_id:
        body["albumId"] = album_id
    return request(GPH + "/v1/mediaItems:batchCreate", "POST", h, json.dumps(body).encode())


def create_album(hdr, title):
    h = dict(hdr)
    h["Content-Type"] = "application/json"
    return request(GPH + "/v1/albums", "POST", h,
                   json.dumps({"album": {"title": title}}).encode())


def item_results(r):
    return ((r.get("json") or {}).get("newMediaItemResults") or [])


def summarize_batch(r):
    return {
        "http": r.get("status"),
        "results": [{
            "code": (i.get("status") or {}).get("code", 0),
            "message": (i.get("status") or {}).get("message"),
            "mediaItemId": (i.get("mediaItem") or {}).get("id"),
            "filename": (i.get("mediaItem") or {}).get("filename"),
        } for i in item_results(r)],
        "top_level_error": (r.get("json") or {}).get("error"),
    }


# --------------------------------------------------------------------------- #
# The suite
# --------------------------------------------------------------------------- #

def run_suite(hdr, results, do_sizecap=False):
    def rec(key, q, derived):
        results[key] = {"question": q, "derived": derived}
        print("  ..  {:<34} {}".format(key, json.dumps(derived)[:110]), file=sys.stderr)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    # ---- U20: does anything work at all from unverified Production? -------- #
    print("\nU20 -- end-to-end from an unverified Production client", file=sys.stderr)
    jpeg = make_jpeg(40 * 1024)
    tok, r = upload_raw(hdr, jpeg)
    bc = batch_create(hdr, [(tok, "u20-smoke-{}.jpg".format(stamp))]) if tok else {}
    rec("U20_end_to_end",
        "U20 -- Does appendonly upload+create succeed from an unverified Production client, "
        "or is verification enforced at the API layer?",
        {"upload_http": r.get("status"), "got_token": bool(tok),
         "batch": summarize_batch(bc) if bc else None,
         "verdict": "works" if tok and bc.get("ok") else "BLOCKED -- plan-invalidating"})
    if not tok:
        print("  Upload failed; aborting suite.", file=sys.stderr)
        return

    # ---- U22 / granularity: session start variants ------------------------ #
    print("\nU22 -- is X-Goog-Upload-Raw-Size mandatory? + granularity", file=sys.stderr)
    variants = {}
    for name, kw in (("with_size", {}),
                     ("omit_size", {"omit_size": True}),
                     ("size_zero", {}),
                     ("alias_header", {"omit_size": True,
                                       "alias": "X-Goog-Upload-Header-Content-Length"})):
        size = 0 if name == "size_zero" else len(jpeg)
        rr = session_start(hdr, size, **kw)
        variants[name] = {"http": rr.get("status"),
                          "session_url": bool(session_url(rr)),
                          "granularity": goog(rr, "X-Goog-Upload-Chunk-Granularity"),
                          "status_hdr": goog(rr, "X-Goog-Upload-Status")}
    rec("U22_raw_size_required",
        "U22 -- Can a resumable session be opened without a known total size? "
        "(If not, go2cloud must HEAD the GoPro CDN before every upload.)", variants)

    gran = None
    for v in variants.values():
        if v.get("granularity"):
            gran = int(v["granularity"])
            break
    for mb, mime in ((1, "image/jpeg"), (200, "video/mp4"), (5000, "video/mp4")):
        rr = session_start(hdr, mb * 1024 * 1024, mime=mime)
        variants["gran_{}mb_{}".format(mb, mime.split("/")[1])] = {
            "granularity": goog(rr, "X-Goog-Upload-Chunk-Granularity"), "http": rr.get("status")}
    rec("granularity_by_size",
        "Is chunk granularity ever anything but 262144, and does it vary by size/type?",
        {k: v for k, v in variants.items() if k.startswith("gran_")})

    # ---- U4: does each chunk POST consume daily quota? -------------------- #
    print("\nU4 -- chunk quota accounting (HIGHEST VALUE)", file=sys.stderr)
    g = gran or 262144
    big = make_jpeg(g * 40)                       # 40 aligned chunks
    rr = session_start(hdr, len(big), mime="image/jpeg")
    surl = session_url(rr)
    n_chunks = 0
    if surl:
        off = 0
        while off < len(big):
            piece = big[off:off + g]
            last = (off + len(piece)) >= len(big)
            cr = chunk_post(hdr, surl, piece, off, finalize=last)
            n_chunks += 1
            if not cr.get("ok"):
                break
            off += len(piece)
        final_tok = (cr.get("text") or "").strip() if cr.get("ok") else None
        bc2 = batch_create(hdr, [(final_tok, "u4-chunked-{}.jpg".format(stamp))]) if final_tok else {}
    else:
        final_tok, bc2 = None, {}
    rec("U4_chunk_quota",
        "U4 -- Do individual chunk POSTs each consume the 10,000/day quota? "
        "REQUIRES a manual read of the Cloud Console quota dashboard ~10 min after this run.",
        {"granularity": g, "chunks_posted": n_chunks,
         "requests_this_upload": 1 + n_chunks + (1 if bc2 else 0),
         "created": bool(final_tok and bc2.get("ok")),
         "HOW_TO_READ": "Cloud Console -> APIs & Services -> Photos Library API -> Quotas. "
                        "Delta ~= {} means chunks count individually (chunking is quota-prohibitive). "
                        "Delta ~= 2-3 means only start+batchCreate count.".format(2 + n_chunks)})

    # ---- Offset mismatch, misalignment, query, lost finalize -------------- #
    print("\nProtocol edge cases", file=sys.stderr)
    med = make_jpeg(g * 4)
    rr = session_start(hdr, len(med))
    surl = session_url(rr)
    edge = {}
    if surl:
        c1 = chunk_post(hdr, surl, med[:g], 0)
        edge["first_chunk_http"] = c1.get("status")
        q1 = session_query(hdr, surl)
        edge["query_after_1"] = {"http": q1.get("status"),
                                 "status": goog(q1, "X-Goog-Upload-Status"),
                                 "size_received": goog(q1, "X-Goog-Upload-Size-Received")}
        skip = chunk_post(hdr, surl, med[g * 2:g * 3], g * 2)   # deliberate gap
        edge["wrong_offset"] = {"http": skip.get("status"),
                                "status": goog(skip, "X-Goog-Upload-Status")}
        q2 = session_query(hdr, surl)
        edge["query_after_gap"] = {"status": goog(q2, "X-Goog-Upload-Status"),
                                   "size_received": goog(q2, "X-Goog-Upload-Size-Received")}
        replay = chunk_post(hdr, surl, med[:g], 0)              # re-send committed offset
        edge["replay_offset_0"] = {"http": replay.get("status"),
                                   "status": goog(replay, "X-Goog-Upload-Status")}
        mis = chunk_post(hdr, surl, med[:300000], 0)            # misaligned non-final chunk
        edge["misaligned_chunk"] = {"http": mis.get("status"),
                                    "status": goog(mis, "X-Goog-Upload-Status")}
    rec("protocol_edge_cases",
        "Offset mismatch, replay, misalignment and query behaviour -- drives resume logic",
        edge)

    bogus = session_query(hdr, (surl or GPH + "/v1/uploads") + "XYZ")
    rec("unknown_session",
        "What does querying a corrupted/unknown session URL return? "
        "(decides restart-vs-terminal in recovery code)",
        {"http": bogus.get("status"), "status": goog(bogus, "X-Goog-Upload-Status")})

    # ---- U36: 207 partial failure with a real per-item error --------------- #
    print("\nU36 -- partial batch failure", file=sys.stderr)
    good1, _ = upload_raw(hdr, make_jpeg(30 * 1024))
    junk, _ = upload_raw(hdr, b"this is definitely not an image" * 200)
    good2, _ = upload_raw(hdr, make_jpeg(31 * 1024))
    pairs = [(t, "u36-{}-{}.jpg".format(i, stamp))
             for i, t in enumerate([good1, junk, good2]) if t]
    br = batch_create(hdr, pairs) if pairs else {}
    rec("U36_partial_failure",
        "Does a bad item fail only itself (207) or the whole batch? What integer code?",
        summarize_batch(br) if br else {"error": "no tokens"})

    # ---- U21: dedupe + album + filename ------------------------------------ #
    print("\nU21 -- dedupe across albums", file=sys.stderr)
    a1 = create_album(hdr, "go2cloud-probe-A-" + stamp)
    a2 = create_album(hdr, "go2cloud-probe-B-" + stamp)
    id1 = (a1.get("json") or {}).get("id")
    id2 = (a2.get("json") or {}).get("id")
    same = make_jpeg(64 * 1024)
    t1, _ = upload_raw(hdr, same)
    r1 = batch_create(hdr, [(t1, "first-{}.jpg".format(stamp))], album_id=id1)
    t2, _ = upload_raw(hdr, same)          # identical bytes, genuinely new token
    r2 = batch_create(hdr, [(t2, "second-{}.jpg".format(stamp))], album_id=id2)
    s1, s2 = summarize_batch(r1), summarize_batch(r2)
    m1 = s1["results"][0]["mediaItemId"] if s1["results"] else None
    m2 = s2["results"][0]["mediaItemId"] if s2["results"] else None
    rec("U21_dedupe_album",
        "U21 -- Does re-submitting identical bytes with a different albumId reuse the same "
        "mediaItem, and does it land in the second album?",
        {"album_a": bool(id1), "album_b": bool(id2), "first": s1, "second": s2,
         "same_media_item": (m1 is not None and m1 == m2),
         "verdict": "content-deduped" if m1 and m1 == m2 else "distinct items"})

    # ---- fileName edge cases ---------------------------------------------- #
    tk_a, _ = upload_raw(hdr, make_jpeg(20 * 1024))
    tk_b, _ = upload_raw(hdr, make_jpeg(21 * 1024))
    tk_c, _ = upload_raw(hdr, make_jpeg(22 * 1024))
    names = ["with-ext-{}.jpg".format(stamp), "noext-{}".format(stamp), "x" * 300 + ".jpg"]
    fr = batch_create(hdr, [(t, n) for t, n in zip([tk_a, tk_b, tk_c], names) if t])
    rec("filename_edge_cases",
        "Is fileName honoured with no extension / at 300 chars?", summarize_batch(fr))

    # ---- album write-through ---------------------------------------------- #
    lst = request(GPH + "/v1/albums?pageSize=50", "GET", hdr)
    rec("albums_list",
        "Does albums.list return only app-created albums, and is isWriteable true?",
        {"http": lst.get("status"),
         "albums": [{"title": a.get("title"), "isWriteable": a.get("isWriteable"),
                     "count": a.get("mediaItemsCount")}
                    for a in ((lst.get("json") or {}).get("albums") or [])][:8]})

    # ---- U17: video size cap (opt-in; slow and bandwidth-heavy) ------------ #
    if do_sizecap:
        print("\nU17 -- video size cap (this uploads many GB and is slow)", file=sys.stderr)
        caps = {}
        for gb in (9.5, 11):
            n = int(gb * 1024 * 1024 * 1024)
            rr = session_start(hdr, n, mime="video/mp4")
            caps["{}GB".format(gb)] = {"start_http": rr.get("status"),
                                       "session": bool(session_url(rr)),
                                       "note": "session-open only; bytes not sent"}
        rec("U17_size_cap_sessions",
            "U17 -- Does /v1/uploads refuse a >10GB session up front, or only fail later?", caps)


def refresh_check(results):
    """The day-8 verdict: Production must survive, Testing must die."""
    out = {}
    for project in ("test", "control"):
        p = token_path(project)
        if not os.path.exists(p):
            out[project] = {"error": "no tokens minted"}
            continue
        tok = json.load(open(p))
        age_days = (time.time() - tok.get("obtained_at", 0)) / 86400.0
        at, r = refresh(project)
        out[project] = {
            "minted_at": tok.get("obtained_at_iso"),
            "age_days": round(age_days, 2),
            "refresh_ok": bool(at),
            "http": r.get("status"),
            "error": (r.get("json") or {}).get("error"),
            "error_description": (r.get("json") or {}).get("error_description"),
        }
    t, c = out.get("test", {}), out.get("control", {})
    if t.get("age_days", 0) < 8:
        verdict = "TOO EARLY -- re-run after day 8 (currently day {})".format(t.get("age_days"))
    elif t.get("refresh_ok") and not c.get("refresh_ok"):
        verdict = "U18 CONFIRMED: Production survives, Testing expired. Proceed with self-publish."
    elif t.get("refresh_ok") and c.get("refresh_ok"):
        verdict = "INVALID: control also survived -- the 7-day rule did not apply; experiment proves nothing."
    else:
        verdict = "U18 REFUTED: Production token also expired. Fall back to Testing + weekly re-auth."
    results["U18_refresh_survival"] = {
        "question": "U18 -- Do refresh tokens survive past day 7 in unverified Production?",
        "derived": {"projects": out, "verdict": verdict}}
    print("\n" + verdict + "\n", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="go2cloud Google Photos protocol probe")
    ap.add_argument("--auth", action="store_true", help="run the OAuth consent flow")
    ap.add_argument("--project", default="test", choices=["test", "control"])
    ap.add_argument("--suite", action="store_true", help="run the full protocol suite")
    ap.add_argument("--refresh-check", action="store_true", help="the day-8 U18 verdict")
    ap.add_argument("--size-cap", action="store_true", help="also probe the 10 vs 20 GB cap")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    if args.auth:
        do_auth(args.project)
        return 0

    results = OrderedDict()
    if args.refresh_check:
        refresh_check(results)
    elif args.suite:
        sys.stderr.write(
            "\n*** THIS PROBE WRITES. It uploads media and creates albums, and the Google\n"
            "*** Photos API cannot delete them. Use a throwaway account.\n")
        if os.environ.get("GO2CLOUD_PROBE_YES") != "1":
            try:
                if input("\nProceed? [y/N] ").strip().lower() not in ("y", "yes"):
                    return 1
            except EOFError:
                sys.stderr.write("Non-interactive: set GO2CLOUD_PROBE_YES=1 to confirm.\n")
                return 1
        run_suite(auth_header("test"), results, do_sizecap=args.size_cap)
    else:
        ap.print_help()
        return 0

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    path = args.out + ".json"
    prior = json.load(open(path)) if os.path.exists(path) else {}
    prior.update({"generated_at": datetime.now(timezone.utc).isoformat(), **results})
    with open(path, "w") as fh:
        json.dump(prior, fh, indent=2)
    sys.stderr.write("Wrote {}\n".format(path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
