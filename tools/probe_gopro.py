#!/usr/bin/env python3
"""
go2cloud -- GoPro Cloud API live probe (settles PLAN.md section 11, phases A-D)

GoPro publishes no documentation for its cloud API. Research settled a great deal
from client source code, but a set of questions can only be answered by asking the
real API with real credentials. This script asks them, once, cheaply and safely.

Safety properties (deliberate -- please preserve them):
  * READ-ONLY. Only GET and HEAD are ever issued. Nothing is created, modified or
    deleted, and no media body is ever downloaded (HEAD returns headers only).
  * The access token is read from disk and is NEVER printed, logged, or written
    into any output file.
  * Signed CDN URLs are redacted before results are written -- their query strings
    carry credentials. `Expires` is preserved because it answers a real question
    (URL lifetime); Signature / Key-Pair-Id / Policy are stripped.
  * Requests are sequential with a delay and capped. No burst or parallel testing:
    hammering an undocumented API with someone's real account is not worth the risk
    of a rate-limit flag, so the rate-limit question is left to empirical tuning.

Standard library only (targets system Python 3.9).

Usage:
    python3 tools/probe_gopro.py --dry-run     # review planned requests, no network
    python3 tools/probe_gopro.py               # run it
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone

API_ROOT = "https://api.gopro.com"
TOKEN_PATH = os.path.expanduser("~/.go2cloud/probe_token")
USER_ID_PATH = os.path.expanduser("~/.go2cloud/probe_user_id")

REQUEST_DELAY_SECONDS = 0.6
MAX_REQUESTS = 130
TIMEOUT_SECONDS = 30

A_MED = "application/vnd.gopro.jk.media+json; version=2.0.0"
A_COL = "application/vnd.gopro.jk.collections+json; version=2.0.0"
A_JSON = "application/json"

USER_AGENT = "go2cloud-probe/0.2 (+https://github.com/KennyCT/go2cloud) read-only-api-survey"

SECRET_QUERY_KEYS = {
    "signature", "key-pair-id", "policy", "token", "access_token",
    "x-amz-signature", "x-amz-credential", "x-amz-security-token", "awsaccesskeyid",
}
KEEP_QUERY_KEYS = {"expires", "x-amz-expires", "x-amz-date", "ver"}

_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*")

# Fields worth asking for. Unknown names appear to be silently dropped, which P12 verifies.
RICH_FIELDS = (
    "id,type,filename,file_extension,file_size,width,height,resolution,"
    "captured_at,captured_at_timezone,created_at,updated_at,submitted_at,"
    "item_count,source_duration,ready_to_view,available_labels,mce_type,play_as,"
    "stabilized,camera_model,content_title,fov,orientation,moments_count"
)


# --------------------------------------------------------------------------- #
# Redaction
# --------------------------------------------------------------------------- #

def redact_url(url):
    """Strip credential-bearing query params from a signed CDN URL; keep Expires."""
    if not isinstance(url, str) or "://" not in url:
        return url
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return "<UNPARSEABLE_URL>"
    if not parts.query:
        return url
    kept = []
    for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        kept.append((key, value if key.lower() in KEEP_QUERY_KEYS else "<REDACTED>"))
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(kept), "")
    )


def scrub(obj, depth=0, list_cap=12):
    if depth > 12:
        return "<MAX_DEPTH>"
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(v, str) and (k.lower() in ("url", "head", "href") or "://" in v):
                out[k] = redact_url(v)
            elif isinstance(v, list) and k.lower() in ("urls", "heads"):
                out[k] = [redact_url(u) for u in v[:3]]
            else:
                out[k] = scrub(v, depth + 1, list_cap)
        return out
    if isinstance(obj, list):
        result = [scrub(v, depth + 1, list_cap) for v in obj[:list_cap]]
        if len(obj) > list_cap:
            result.append("<{} more omitted>".format(len(obj) - list_cap))
        return result
    if isinstance(obj, str):
        return _JWT_RE.sub("<REDACTED_JWT>", obj)
    return obj


def expires_from(url):
    """Pull the CloudFront/S3 expiry epoch out of a signed URL, if present."""
    try:
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
    except ValueError:
        return None
    for key in ("Expires", "X-Amz-Expires"):
        if key in q:
            try:
                return int(q[key])
            except ValueError:
                return None
    return None


# --------------------------------------------------------------------------- #
# HTTP client
# --------------------------------------------------------------------------- #

class Probe:
    def __init__(self, token, user_id="", dry_run=False):
        self._token = token
        self._user_id = user_id
        self.dry_run = dry_run
        self.request_count = 0
        self.planned = []

    def _send(self, url, method, accept, auth_mode, note, host_label, scrub_body=True):
        self.planned.append({"method": method, "url": url if host_label == "api" else "<signed CDN url>",
                             "accept": accept, "auth": auth_mode, "note": note})
        if self.dry_run:
            return {"dry_run": True}
        if self.request_count >= MAX_REQUESTS:
            return {"skipped": "request budget exhausted"}
        if self.request_count:
            time.sleep(REQUEST_DELAY_SECONDS)
        self.request_count += 1

        req = urllib.request.Request(url, method=method)
        req.add_header("User-Agent", USER_AGENT)
        if host_label == "api":
            req.add_header("Accept", accept)
            # Send the token on the requested channel(s). U1 asks which one the API
            # actually honours, so the auth-channel probe drives these individually.
            if auth_mode in ("bearer", "both"):
                req.add_header("Authorization", "Bearer " + self._token)
            if auth_mode in ("cookie", "both"):
                cookie = "gp_access_token=" + self._token
                if self._user_id:
                    cookie += "; gp_user_id=" + self._user_id
                req.add_header("Cookie", cookie)
            if auth_mode == "bearer_gpuid" and self._user_id:
                req.add_header("Authorization", "Bearer " + self._token)
                req.add_header("gp-user-id", self._user_id)

        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                raw = resp.read() if method == "GET" else b""
                status, headers = resp.status, dict(resp.headers)
        except urllib.error.HTTPError as e:
            raw = e.read()[:4000]
            status, headers = e.code, dict(e.headers)
        except Exception as e:  # noqa: BLE001 -- one bad request must not kill the probe
            return {"error": "{}: {}".format(type(e).__name__, e),
                    "elapsed_ms": int((time.time() - started) * 1000)}

        text = raw.decode("utf-8", errors="replace")
        parsed = None
        try:
            parsed = json.loads(text)
        except ValueError:
            pass

        keep = ("x-ratelimit", "x-rate-limit", "retry-after", "x-request-id",
                "content-type", "content-length", "content-disposition",
                "accept-ranges", "x-amz-storage-class", "server", "x-gp")
        notable = {k: v for k, v in headers.items() if k.lower().startswith(keep)}

        return {
            "method": method, "accept": accept, "auth": auth_mode,
            "status": status, "ok": 200 <= status < 300,
            "elapsed_ms": int((time.time() - started) * 1000),
            "headers": notable,
            "json": (scrub(parsed) if scrub_body else parsed) if parsed is not None else None,
            "body_snippet": None if parsed is not None else text[:500],
        }

    def get(self, path, params=None, accept=A_MED, auth="both", note="", raw=False):
        """raw=True returns the UNSCRUBBED body for in-memory use only.

        Needed because a signed CDN URL must stay intact to be HEADed, but must never
        reach the results dict. Callers must not store a raw result.
        """
        url = API_ROOT + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        r = self._send(url, "GET", accept, auth, note, "api", scrub_body=not raw)
        r["path"] = path
        r["params"] = params
        return r

    def head_cdn(self, url, note=""):
        """HEAD a signed CDN URL. Returns headers only -- no media bytes."""
        r = self._send(url, "HEAD", "", "none", note, "cdn")
        r["url_redacted"] = redact_url(url)
        return r


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def media_of(r):
    if not r or not r.get("ok"):
        return []
    emb = (r.get("json") or {}).get("_embedded") or {}
    return [m for m in (emb.get("media") or []) if isinstance(m, dict)]


def pages_of(r):
    if not r or not r.get("ok"):
        return {}
    return (r.get("json") or {}).get("_pages") or {}


def total_items(r):
    return pages_of(r).get("total_items")


# --------------------------------------------------------------------------- #
# Probes
# --------------------------------------------------------------------------- #

def run_probes(p, results):
    def rec(key, uref, question, r):
        results[key] = {"answers": uref, "question": question, "result": r}
        if not p.dry_run:
            st = r.get("status", r.get("skipped") or r.get("error", "ERR"))
            print("  {}{:<34} {}".format("ok  " if r.get("ok") else "--  ", key, st), file=sys.stderr)
        return r

    # ===== Phase A: auth channel (U1) ====================================== #
    print("\nPhase A -- auth channel", file=sys.stderr)
    for mode in ("bearer", "cookie", "both", "bearer_gpuid"):
        rec("auth_" + mode, ["U1"],
            "U1 -- Does the API accept the token as Bearer, as a Cookie, or both?",
            p.get("/media/search", {"per_page": 1, "fields": "id"}, auth=mode,
                  note="auth channel: " + mode))

    working = next((m for m in ("both", "bearer", "cookie", "bearer_gpuid")
                    if (results.get("auth_" + m, {}).get("result") or {}).get("ok")), None)
    if not p.dry_run and working is None:
        print("\n  No auth channel worked. Token is missing/expired -- re-copy it.\n", file=sys.stderr)
        return
    auth = working or "both"

    # ===== Phase B: albums / collections (U5, U6-partial) ================== #
    print("\nPhase B -- albums / collections", file=sys.stderr)
    col = rec("collections_list", ["U5"],
              "U5 -- Does GET /collections list albums (label=mural) as well as share links?",
              p.get("/collections", {"page": 1, "per_page": 50}, accept=A_COL, auth=auth,
                    note="authenticated collections listing"))
    rec("media_items_list", ["U5c"],
        "U5c -- Does GET /media/items act as the album lister instead?",
        p.get("/media/items", {"page": 1, "per_page": 50}, accept=A_MED, auth=auth,
              note="media/items album lister"))

    base_col = total_items(col)
    for label, q in (("label_mural", {"label": "mural"}),
                     ("label_hiddenshare", {"label": "hiddenshare"}),
                     ("control_bogus", {"zzz_bogus": "1"})):
        rec("collections_filter_" + label, ["U5b"],
            "U5b -- Is server-side label filtering supported, or must go2cloud filter client-side? "
            "(control_bogus defines what 'silently ignored' looks like)",
            p.get("/collections", dict({"page": 1, "per_page": 50}, **q), accept=A_COL, auth=auth,
                  note="collections filter: " + label))

    # Look inside the first collection we can find.
    first_col_id = None
    for src in ("collections_list", "media_items_list"):
        body = ((results.get(src) or {}).get("result") or {}).get("json") or {}
        emb = body.get("_embedded") or {}
        for k in ("collections", "items", "media"):
            arr = emb.get(k)
            if isinstance(arr, list) and arr and isinstance(arr[0], dict) and arr[0].get("id"):
                first_col_id = arr[0]["id"]
                results["_first_collection_source"] = {"source": src, "array_key": k}
                break
        if first_col_id:
            break

    if first_col_id:
        rec("collection_detail", ["U5"], "U5 -- Shape of a single collection object",
            p.get("/collections/" + first_col_id, accept=A_COL, auth=auth, note="collection detail"))
        rec("collection_media", ["U5"], "U5 -- How is collection membership enumerated?",
            p.get("/collections/{}/media".format(first_col_id), {"page": 1, "per_page": 5},
                  accept=A_MED, auth=auth, note="collection membership"))
        for pname in ("collection_id", "parent_id", "item_id"):
            rec("search_filter_" + pname, ["U5d"],
                "U5d -- Can /media/search filter by collection, avoiding the N+1 album pass?",
                p.get("/media/search", {"fields": "id", "per_page": 1, pname: first_col_id},
                      auth=auth, note="collection filter on search: " + pname))

    rec("search_backref_fields", ["U5d"],
        "U5d -- Do media rows carry any collection back-reference?",
        p.get("/media/search",
              {"fields": "id,parent_ids,collection_ids,album_ids,item_ids,collections", "per_page": 2},
              auth=auth, note="back-reference field probe"))
    rec("search_default_shape", ["U5d", "U13"],
        "What does a media row look like with no fields= filter (reveals _links / defaults)?",
        p.get("/media/search", {"per_page": 2, "page": 1}, auth=auth, note="default row shape"))

    # ===== Phase C: search semantics (U7, U8, U12, U13, U14) =============== #
    print("\nPhase C -- search semantics", file=sys.stderr)
    base = rec("search_baseline", ["U8"], "Baseline total_items for filter comparisons",
               p.get("/media/search", {"fields": "id", "per_page": 1}, auth=auth, note="baseline count"))
    baseline_total = total_items(base)

    for key in ("created_range", "submitted_range", "created_at_range", "updated_range",
                "ingested_range", "zzz_range"):
        rec("uploaddate_" + key, ["U8"],
            "U8 -- Does a server-side UPLOAD-date filter exist? (zzz_range is the ignored-control)",
            p.get("/media/search",
                  {"fields": "id", "per_page": 1,
                   key: "2024-01-01T00:00:00.000Z,2024-02-01T00:00:00.000Z"},
                  auth=auth, note="upload-date filter candidate: " + key))

    for ob in ("created_at", "captured_at"):
        rec("sort_first_" + ob, ["U7"],
            "U7 -- Is order_by descending by default? (incremental sync depends on it)",
            p.get("/media/search", {"fields": "id,captured_at,created_at", "order_by": ob,
                                    "per_page": 5, "page": 1}, auth=auth,
                  note="sort direction, first page: " + ob))
    for variant, params in (("order_desc", {"order_by": "created_at", "order": "desc"}),
                            ("order_asc", {"order_by": "created_at", "order": "asc"}),
                            ("minus_prefix", {"order_by": "-created_at"})):
        rec("sortdir_" + variant, ["U7b"],
            "U7b -- Is there any order-direction parameter at all?",
            p.get("/media/search", dict({"fields": "id,created_at", "per_page": 3}, **params),
                  auth=auth, note="sort direction variant: " + variant))

    for n in (100, 200, 500, 1000):
        rec("per_page_{}".format(n), ["U12"],
            "U12 -- What is the real per_page ceiling, and does the server clamp or 4xx?",
            p.get("/media/search", {"fields": "id", "per_page": n, "page": 1}, auth=auth,
                  note="per_page ceiling: {}".format(n)))

    for key, params in (("bad_field", {"fields": "id,not_a_real_field_xyz"}),
                        ("bad_type", {"fields": "id", "type": "NotAType"}),
                        ("bad_state", {"fields": "id", "processing_states": "notastate"})):
        rec("tolerance_" + key, ["U13"],
            "U13 -- Does an unknown value 4xx, get dropped, or land in _embedded.errors? "
            "(decides whether a forward-compatible field superset is safe)",
            p.get("/media/search", dict({"per_page": 1}, **params), auth=auth,
                  note="unknown-value tolerance: " + key))

    rich = rec("fields_rich", ["U13", "U8b"],
               "Which of the rich field set actually return values? Do captured_at nulls exist?",
               p.get("/media/search", {"fields": RICH_FIELDS, "per_page": 100, "page": 1,
                                       "order_by": "created_at"}, auth=auth,
                     note="rich field roster + library sample"))

    for label, rng in (("same_day", "2024-06-01T00:00:00.000Z,2024-06-01T00:00:00.000Z"),
                       ("to_next_midnight", "2024-06-01T00:00:00.000Z,2024-06-02T00:00:00.000Z"),
                       ("to_235959", "2024-06-01T00:00:00.000Z,2024-06-01T23:59:59.000Z")):
        rec("captured_range_" + label, ["U14"],
            "U14 -- Is captured_range end-exclusive? (same_day==0 but to_next_midnight>0 means half-open)",
            p.get("/media/search", {"fields": "id,captured_at", "per_page": 5, "captured_range": rng},
                  auth=auth, note="captured_range semantics: " + label))

    # ===== Phase D: download semantics (U9, U10, U11, U16, U20) ============ #
    print("\nPhase D -- download semantics", file=sys.stderr)
    sample = media_of(rich)
    results["_library_sample"] = {
        "sampled_rows": len(sample),
        "total_items_reported": baseline_total,
        "types_seen": sorted({str(m.get("type")) for m in sample}),
        "extensions_seen": sorted({str(m.get("file_extension") or
                                        os.path.splitext(str(m.get("filename") or ""))[1].lstrip("."))
                                   for m in sample}),
        "rows_missing_captured_at": sum(1 for m in sample if not m.get("captured_at")),
        "rows_with_item_count_gt1": sum(1 for m in sample if (m.get("item_count") or 0) > 1),
    }

    # Choose interesting representatives: one per type, one .360, one multi-chapter.
    picks = OrderedDict()
    for m in sample:
        if not m.get("id"):
            continue
        t = str(m.get("type") or "Unknown")
        ext = str(m.get("file_extension") or "").lower()
        fn = str(m.get("filename") or "").lower()
        if (ext == "360" or fn.endswith(".360")) and "360file" not in picks:
            picks["360file"] = m
        elif (m.get("item_count") or 0) > 1 and "multi_" + t not in picks:
            picks["multi_" + t] = m
        elif t not in picks:
            picks[t] = m

    for tag, m in list(picks.items())[:6]:
        safe = re.sub(r"\W+", "_", tag)
        dl = rec("download_" + safe, ["U9", "U10", "U11"],
                 "U9/U10/U11 -- variations[] vs files[] for {}: which label is the original, "
                 "how are chapters/bursts laid out, and how does .360 present?".format(tag),
                 p.get("/media/{}/download".format(m["id"]), auth=auth,
                       note="download manifest: " + tag))
        body = dl.get("json") or {}
        emb = body.get("_embedded") or {}
        summary = {
            "arrays_present": sorted(emb.keys()),
            "variations": [{k: v.get(k) for k in
                            ("label", "type", "quality", "width", "height", "item_number", "available")}
                           for v in (emb.get("variations") or []) if isinstance(v, dict)],
            "files": [{k: v.get(k) for k in ("type", "width", "height", "item_number")}
                      for v in (emb.get("files") or []) if isinstance(v, dict)],
            "variation_field_names": sorted({k for v in (emb.get("variations") or [])
                                             if isinstance(v, dict) for k in v}),
            "file_field_names": sorted({k for v in (emb.get("files") or [])
                                        if isinstance(v, dict) for k in v}),
            "sidecar_labels": [v.get("label") or v.get("type") for v in (emb.get("sidecar_files") or [])
                               if isinstance(v, dict)],
        }
        results["download_" + safe]["derived"] = summary

    # -- U16 + exact size: measure TTL and CDN Content-Length ----------------
    # The signed URL must stay unscrubbed to be HEADable, so it is fetched raw and
    # kept only in a local variable -- it is never written into `results`.
    ttl_target = next(iter(picks.values()), None)
    if ttl_target and not p.dry_run:
        raw = p.get("/media/{}/download".format(ttl_target["id"]), auth=auth, raw=True,
                    note="fresh manifest for TTL + size measurement")
        emb = (raw.get("json") or {}).get("_embedded") or {}
        src = next((v for v in (emb.get("variations") or [])
                    if isinstance(v, dict) and v.get("label") in ("source", "baked_source")), None)
        if src is None:
            src = next((v for v in (emb.get("files") or []) if isinstance(v, dict)), None)
        if src and src.get("url"):
            signed = src["url"]
            exp = expires_from(signed)
            head = p.head_cdn(src.get("head") or signed, note="CDN size probe (headers only)")
            results["url_ttl_and_size"] = {
                "answers": ["U16", "U22"],
                "question": ("U16 -- signed CDN URL TTL (drives mandatory mid-file re-resolve); "
                             "U22 -- is CDN Content-Length exact enough for X-Goog-Upload-Raw-Size?"),
                "derived": {
                    "expires_epoch": exp,
                    "ttl_seconds": (exp - int(time.time())) if exp else None,
                    "query_keys": sorted(dict(urllib.parse.parse_qsl(
                        urllib.parse.urlsplit(signed).query)).keys()),
                    "cdn_status": head.get("status"),
                    "cdn_headers": head.get("headers"),
                    "search_row_file_size": ttl_target.get("file_size"),
                },
            }
            print("  ..  url_ttl_and_size                  ttl={}s cdn={}".format(
                results["url_ttl_and_size"]["derived"]["ttl_seconds"], head.get("status")),
                file=sys.stderr)

    rec("dead_end_source_param", ["U-cheap"],
        "Is there a ?source=true shortcut on /download? (expected: silently ignored)",
        p.get("/media/{}/download".format(ttl_target["id"]) if ttl_target else "/media/x/download",
              {"source": "true"}, auth=auth, note="dead-end confirmation"))


# --------------------------------------------------------------------------- #
# Analysis + reporting
# --------------------------------------------------------------------------- #

def analyse(results):
    """Turn raw responses into direct answers to the U-numbers."""
    out = OrderedDict()

    def res(k):
        return (results.get(k) or {}).get("result") or {}

    ok_modes = [m for m in ("bearer", "cookie", "both", "bearer_gpuid") if res("auth_" + m).get("ok")]
    out["U1_auth_channel"] = {
        "working_modes": ok_modes,
        "verdict": ("Bearer works -- OAuth refresh path is viable" if "bearer" in ok_modes
                    else "Cookie-only -- Playwright capture cannot be replaced by OAuth"
                    if ok_modes else "no channel worked (token expired?)"),
    }

    col, items = res("collections_list"), res("media_items_list")

    def labels_in(r):
        emb = (r.get("json") or {}).get("_embedded") or {}
        found = set()
        for arr in emb.values():
            if isinstance(arr, list):
                for v in arr:
                    if isinstance(v, dict) and v.get("label"):
                        found.add(str(v["label"]))
        return sorted(found)

    out["U5_album_lister"] = {
        "collections_status": col.get("status"),
        "collections_total": total_items(col),
        "collections_labels": labels_in(col),
        "collections_arrays": sorted(((col.get("json") or {}).get("_embedded") or {}).keys()),
        "media_items_status": items.get("status"),
        "media_items_total": total_items(items),
        "media_items_labels": labels_in(items),
        "media_items_arrays": sorted(((items.get("json") or {}).get("_embedded") or {}).keys()),
        "verdict": ("/collections usable as album lister" if "mural" in labels_in(col)
                    else "/media/items required for albums" if items.get("ok")
                    else "inconclusive -- inspect raw bodies"),
    }

    base = total_items(res("search_baseline"))
    ctrl = total_items(res("uploaddate_zzz_range"))
    real = {}
    for key in ("created_range", "submitted_range", "created_at_range", "updated_range", "ingested_range"):
        t = total_items(res("uploaddate_" + key))
        if t is not None and base is not None and t != base:
            real[key] = t
    out["U8_upload_date_filter"] = {
        "baseline_total": base, "ignored_control_total": ctrl,
        "filters_that_changed_total": real,
        "verdict": ("supported via " + ", ".join(real) if real
                    else "NOT supported -- upload-date filtering must be client-side"),
    }

    def first_ts(k, field):
        m = media_of(res(k))
        return m[0].get(field) if m else None

    out["U7_sort_direction"] = {
        "created_at_first": first_ts("sort_first_created_at", "created_at"),
        "created_at_all": [m.get("created_at") for m in media_of(res("sort_first_created_at"))],
        "captured_at_first": first_ts("sort_first_captured_at", "captured_at"),
        "captured_at_all": [m.get("captured_at") for m in media_of(res("sort_first_captured_at"))],
        "note": "Descending if the list runs newest -> oldest. Incremental sync depends on this.",
    }

    ceiling = {}
    for n in (100, 200, 500, 1000):
        r = res("per_page_{}".format(n))
        ceiling[n] = {"status": r.get("status"), "returned": len(media_of(r)),
                      "pages_per_page": pages_of(r).get("per_page")}
    out["U12_per_page_ceiling"] = ceiling

    out["U13_unknown_value_tolerance"] = {
        k: {"status": res("tolerance_" + k).get("status"),
            "errors": ((res("tolerance_" + k).get("json") or {}).get("_embedded") or {}).get("errors")}
        for k in ("bad_field", "bad_type", "bad_state")
    }

    out["U14_captured_range"] = {
        k: total_items(res("captured_range_" + k))
        for k in ("same_day", "to_next_midnight", "to_235959")
    }

    out["U9_U10_U11_download"] = {
        k[len("download_"):]: results[k].get("derived")
        for k in results if k.startswith("download_") and results[k].get("derived")
    }
    out["U16_url_ttl_and_size"] = (results.get("url_ttl_and_size") or {}).get("derived")
    out["library"] = results.get("_library_sample")
    return out


def write_reports(results, analysis, out_prefix, request_count):
    d = os.path.dirname(out_prefix)
    if d:
        os.makedirs(d, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "probe_version": "0.2",
        "requests_issued": request_count,
        "note": "READ-ONLY probe. Token and signed CDN credentials redacted.",
        "analysis": analysis,
        "probes": results,
    }
    with open(out_prefix + ".json", "w") as fh:
        json.dump(payload, fh, indent=2)

    lines = ["# GoPro Cloud API — live probe results", "",
             "Generated {} · {} read-only requests".format(payload["generated_at"], request_count), "",
             "> The access token and signed CDN credentials are redacted in this file.", "",
             "## Answers", "", "```json", json.dumps(analysis, indent=2)[:9000], "```", "",
             "## All probes", "", "| Probe | HTTP | Answers | Question |", "| --- | --- | --- | --- |"]
    for k, e in results.items():
        if k.startswith("_"):
            continue
        r = e.get("result") or {}
        lines.append("| `{}` | {} | {} | {} |".format(
            k, r.get("status", r.get("error", "?")), ",".join(e.get("answers") or []),
            str(e.get("question", "")).replace("|", "/")[:110]))
    with open(out_prefix + ".md", "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return out_prefix + ".json", out_prefix + ".md"


def main():
    ap = argparse.ArgumentParser(description="go2cloud GoPro Cloud read-only API probe")
    ap.add_argument("--dry-run", action="store_true", help="list planned requests, no network")
    ap.add_argument("--out", default="docs/probe-results")
    ap.add_argument("--token-file", default=TOKEN_PATH)
    args = ap.parse_args()

    token, user_id = "", ""
    if not args.dry_run:
        token = os.environ.get("GP_ACCESS_TOKEN", "").strip()
        if not token and os.path.exists(args.token_file):
            token = open(args.token_file).read().strip()
        if not token:
            sys.stderr.write(
                "\nNo GoPro token found.\n\n  Expected at : {}\n  Or export   : GP_ACCESS_TOKEN\n\n"
                "  See docs/PROBE.md.  Tip: --dry-run shows every request first.\n\n".format(
                    args.token_file))
            return 2
        if os.path.exists(USER_ID_PATH):
            user_id = open(USER_ID_PATH).read().strip()

    sys.stderr.write("go2cloud GoPro probe -- READ-ONLY (GET/HEAD only), max {} requests\n".format(
        MAX_REQUESTS))
    p = Probe(token, user_id, dry_run=args.dry_run)
    results = OrderedDict()
    run_probes(p, results)

    if args.dry_run:
        sys.stderr.write("\nPlanned requests ({}):\n\n".format(len(p.planned)))
        for i, r in enumerate(p.planned, 1):
            sys.stderr.write("{:>3}. {} {}\n     why: {}\n".format(i, r["method"], r["url"], r["note"]))
        sys.stderr.write("\nDry run -- no network traffic occurred.\n")
        return 0

    analysis = analyse(results)
    j, m = write_reports(results, analysis, args.out, p.request_count)
    sys.stderr.write("\n{} requests issued.\nWrote {}\n      {}\n".format(p.request_count, j, m))
    sys.stderr.write("\n--- Headline answers ---\n")
    for k in ("U1_auth_channel", "U5_album_lister", "U8_upload_date_filter", "U16_url_ttl_and_size"):
        sys.stderr.write("{}: {}\n".format(k, json.dumps(analysis.get(k))[:300]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
