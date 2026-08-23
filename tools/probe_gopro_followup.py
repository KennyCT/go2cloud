#!/usr/bin/env python3
"""
go2cloud -- GoPro Cloud probe, follow-up pass.

The first probe answered most of PLAN.md section 11 but left four things open,
two of them because the probe used a date window (2024) that this library does
not cover, and one because a per_page=100 request returned only 12 rows against
a reported total of 212 -- which is either the documented incomplete-page bug or
a misunderstanding of what total_items counts. Both matter enormously: the first
would mean a scan silently misses most of the library.

Same safety properties as probe_gopro.py: READ-ONLY (GET only), token never
printed or written, signed URLs redacted, sequential with delay.

Usage:
    python3 tools/probe_gopro_followup.py --dry-run
    python3 tools/probe_gopro_followup.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, OrderedDict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_gopro import (  # noqa: E402
    A_MED, API_ROOT, MAX_REQUESTS, REQUEST_DELAY_SECONDS, TOKEN_PATH,
    USER_AGENT, Probe, media_of, pages_of, scrub, total_items,
)

OUT = "docs/probe-results-followup"


def run(p, results):
    def rec(key, question, r, derived=None):
        results[key] = {"question": question, "result": r}
        if derived is not None:
            results[key]["derived"] = derived
        if not p.dry_run:
            st = r.get("status", r.get("error", "ERR")) if isinstance(r, dict) else "-"
            print("  {}{:<36} {}".format("ok  " if (isinstance(r, dict) and r.get("ok")) else "--  ",
                                         key, st), file=sys.stderr)
        return r

    # ===== Q1: the 12-vs-212 discrepancy =================================== #
    # Walk the whole library and count what actually comes back, page by page.
    print("\nQ1 -- full library walk (is total_items trustworthy?)", file=sys.stderr)
    fields = ("id,type,filename,file_extension,file_size,width,height,captured_at,"
              "captured_at_timezone,created_at,submitted_at,upload_completed_at,"
              "item_count,available_labels,mce_type,play_as,parent_id,ready_to_view,"
              "resolution,subscription_type,content_source")
    per_page = 200
    page, walked, page_log = 1, [], []
    reported_total = None
    while page <= 6:
        r = p.get("/media/search",
                  {"fields": fields, "per_page": per_page, "page": page, "order_by": "created_at"},
                  note="full library walk page {}".format(page))
        if not r.get("ok"):
            page_log.append({"page": page, "status": r.get("status"), "returned": 0})
            break
        rows = media_of(r)
        pg = pages_of(r)
        reported_total = pg.get("total_items", reported_total)
        page_log.append({"page": page, "returned": len(rows),
                         "pages_total_items": pg.get("total_items"),
                         "pages_total_pages": pg.get("total_pages"),
                         "pages_per_page": pg.get("per_page")})
        walked.extend(rows)
        if not rows or page >= (pg.get("total_pages") or 0):
            break
        page += 1

    # Does an explicit processing_states widen the result set?
    wide = p.get("/media/search",
                 {"fields": "id,type", "per_page": per_page, "page": 1,
                  "processing_states": "registered,rendering,pretranscoding,transcoding,"
                                       "stabilizing,ready,failure"},
                 note="all processing_states -- does the set widen?")
    ready_only = p.get("/media/search",
                       {"fields": "id,type", "per_page": per_page, "page": 1,
                        "processing_states": "ready"},
                       note="processing_states=ready only")

    ids = [m.get("id") for m in walked if m.get("id")]
    rec("library_walk",
        "Q1 -- Does paging actually return total_items rows, or are pages incomplete?",
        {"ok": True, "status": 200},
        derived={
            "reported_total_items": reported_total,
            "rows_actually_returned": len(walked),
            "unique_ids": len(set(ids)),
            "page_log": page_log,
            "all_states_returned": len(media_of(wide)),
            "all_states_total": total_items(wide),
            "ready_only_returned": len(media_of(ready_only)),
            "ready_only_total": total_items(ready_only),
            "verdict": ("pages are COMPLETE" if reported_total and len(set(ids)) >= reported_total
                        else "MISMATCH -- fewer rows than total_items claims"),
        })

    # Census of the real library -- decides which U-questions this account can answer.
    census = {
        "by_type": dict(Counter(str(m.get("type")) for m in walked)),
        "by_extension": dict(Counter(str(m.get("file_extension")).lower() for m in walked)),
        "by_content_source": dict(Counter(str(m.get("content_source")) for m in walked)),
        "subscription_types": sorted({str(m.get("subscription_type")) for m in walked}),
        "chaptered_item_count_gt1": sum(1 for m in walked if (m.get("item_count") or 0) > 1),
        "missing_captured_at": sum(1 for m in walked if not m.get("captured_at")),
        "has_parent_id": sum(1 for m in walked if m.get("parent_id")),
        "parent_id_samples": [m.get("parent_id") for m in walked if m.get("parent_id")][:3],
        "mce_rows": [{"mce_type": m.get("mce_type"), "play_as": m.get("play_as"),
                      "ext": m.get("file_extension")}
                     for m in walked if str(m.get("type")) == "MultiClipEdit"][:3],
        "total_bytes": sum(int(m.get("file_size") or 0) for m in walked),
        "largest_file_bytes": max([int(m.get("file_size") or 0) for m in walked] or [0]),
        "available_labels_union": sorted({l for m in walked
                                          for l in (m.get("available_labels") or [])}),
        "rows_with_available_labels": sum(1 for m in walked if m.get("available_labels")),
        "timezones": sorted({str(m.get("captured_at_timezone")) for m in walked})[:8],
    }
    results["library_census"] = {
        "question": "What does this account actually contain? (decides which U-questions it can answer)",
        "derived": census,
    }
    if not p.dry_run:
        print("  ..  library_census                     {} rows, {} types".format(
            len(walked), len(census["by_type"])), file=sys.stderr)

    # Date bounds drive the range probes below.
    dates = sorted([str(m.get("created_at")) for m in walked if m.get("created_at")])
    caps = sorted([str(m.get("captured_at")) for m in walked if m.get("captured_at")])
    newest_cap = caps[-1][:10] if caps else "2026-02-14"
    results["_bounds"] = {"created_at_min": dates[0] if dates else None,
                          "created_at_max": dates[-1] if dates else None,
                          "captured_at_min": caps[0] if caps else None,
                          "captured_at_max": caps[-1] if caps else None}

    # ===== Q2: is created_range a REAL filter? ============================= #
    # The first probe saw created_range -> 0 for a 2024 window. That is what a
    # working filter AND a broken one both look like on an empty window, so
    # re-test on a window that definitely contains data.
    print("\nQ2 -- upload-date filter, on a window that has data", file=sys.stderr)
    base = p.get("/media/search", {"fields": "id", "per_page": 1}, note="baseline")
    base_total = total_items(base)
    lo = (dates[0][:10] + "T00:00:00.000Z") if dates else "2026-01-01T00:00:00.000Z"
    hi = (dates[-1][:10] + "T23:59:59.000Z") if dates else "2026-12-31T23:59:59.000Z"

    for name, params in (
        ("created_range_full", {"created_range": lo + "," + hi}),
        ("created_range_narrow", {"created_range": lo + "," + (dates[0][:10] + "T23:59:59.000Z"
                                                               if dates else hi)}),
        ("updated_range_full", {"updated_range": lo + "," + hi}),
        ("control_zzz_range", {"zzz_range": lo + "," + hi}),
    ):
        r = rec("q2_" + name,
                "Q2 -- Is there a real server-side UPLOAD-date filter? "
                "(a real filter changes total_items; the control must not)",
                p.get("/media/search", dict({"fields": "id,created_at", "per_page": 3}, **params),
                      note="upload-date filter: " + name))
        results["q2_" + name]["derived"] = {"total_items": total_items(r),
                                            "baseline": base_total,
                                            "sample": [m.get("created_at") for m in media_of(r)]}

    # ===== Q3: captured_range semantics, on a real date ==================== #
    print("\nQ3 -- captured_range semantics on a populated day", file=sys.stderr)
    for name, rng in (
        ("same_instant", "{}T00:00:00.000Z,{}T00:00:00.000Z".format(newest_cap, newest_cap)),
        ("to_next_midnight", "{}T00:00:00.000Z,{}T23:59:59.999Z".format(newest_cap, newest_cap)),
        ("whole_month", "{}-01T00:00:00.000Z,{}-28T23:59:59.999Z".format(
            newest_cap[:7], newest_cap[:7])),
        ("no_delimiter_test", "{}T00:00:00.000Z".format(newest_cap)),
    ):
        r = rec("q3_" + name,
                "Q3 -- Is captured_range end-exclusive, and what does a malformed value do?",
                p.get("/media/search",
                      {"fields": "id,captured_at,captured_at_timezone", "per_page": 5,
                       "captured_range": rng}, note="captured_range: " + name))
        results["q3_" + name]["derived"] = {"range": rng, "total_items": total_items(r),
                                            "sample": [m.get("captured_at") for m in media_of(r)]}

    # ===== Q4: is the N+1 album pass avoidable? ============================ #
    # /media/items rows carry parent_ids, and the default /media/search row shape
    # contains parent_id. If that is populated and filterable, the N+1 disappears.
    print("\nQ4 -- album back-reference and lister", file=sys.stderr)
    items = rec("media_items_page1",
                "Q4 -- What exactly does /media/items return, and is it the album lister?",
                p.get("/media/items", {"page": 1, "per_page": 30}, note="media/items shape"))
    ib = items.get("json") or {}
    arr = ib.get("items") if isinstance(ib.get("items"), list) else []
    labels = Counter(str(x.get("label")) for x in arr if isinstance(x, dict))
    roots = [x for x in arr if isinstance(x, dict) and x.get("root")]
    parent_union = sorted({pid for x in arr if isinstance(x, dict)
                           for pid in (x.get("parent_ids") or [])})
    results["media_items_page1"]["derived"] = {
        "top_level_keys": sorted(ib.keys()),
        "item_count": len(arr),
        "labels": dict(labels),
        "types": dict(Counter(str(x.get("type")) for x in arr if isinstance(x, dict))),
        "root_items": len(roots),
        "distinct_parent_ids": parent_union[:6],
        "n_distinct_parents": len(parent_union),
        "sample_item_keys": sorted(arr[0].keys()) if arr else [],
    }

    # Try to list the album containers themselves rather than their members.
    for name, params in (("label_mural", {"label": "mural", "per_page": 30}),
                         ("type_collection", {"type": "collection", "per_page": 30}),
                         ("root_true", {"root": "true", "per_page": 30}),
                         ("control_bogus", {"zzz_bogus": "1", "per_page": 30})):
        r = rec("q4_items_" + name,
                "Q4 -- Can /media/items be filtered to return album containers?",
                p.get("/media/items", dict({"page": 1}, **params), note="media/items filter: " + name))
        rb = r.get("json") or {}
        ra = rb.get("items") if isinstance(rb.get("items"), list) else []
        results["q4_items_" + name]["derived"] = {
            "returned": len(ra),
            "labels": dict(Counter(str(x.get("label")) for x in ra if isinstance(x, dict))),
            "types": dict(Counter(str(x.get("type")) for x in ra if isinstance(x, dict))),
        }

    # If we found a parent id, can we fetch it directly and can search filter by it?
    if parent_union:
        pid = parent_union[0]
        rec("q4_parent_detail", "Q4 -- Is a parent_id an album container object?",
            p.get("/media/items/" + pid, note="fetch parent container"))
        rec("q4_parent_children", "Q4 -- Can album membership be listed by parent id?",
            p.get("/media/items", {"parent_id": pid, "per_page": 10}, note="children by parent_id"))
        r = rec("q4_search_by_parent",
                "Q4 -- Can /media/search filter by parent_id, avoiding the N+1 pass?",
                p.get("/media/search", {"fields": "id,parent_id", "per_page": 5, "parent_id": pid},
                      note="search filtered by parent_id"))
        results["q4_search_by_parent"]["derived"] = {"total_items": total_items(r),
                                                     "baseline": base_total}

    # ===== Q5: does available_labels match /download? ====================== #
    # If it does, pre-flight can plan the whole run without one /download per item.
    print("\nQ5 -- can available_labels replace a /download call?", file=sys.stderr)
    checked = 0
    for m in walked:
        if checked >= 3 or not m.get("id") or not m.get("available_labels"):
            continue
        r = p.get("/media/{}/download".format(m["id"]), note="cross-check available_labels")
        emb = (r.get("json") or {}).get("_embedded") or {}
        actual = sorted({str(v.get("label")) for v in (emb.get("variations") or [])
                         if isinstance(v, dict)})
        declared = sorted(str(x) for x in (m.get("available_labels") or []))
        key = "q5_labels_{}".format(checked)
        results[key] = {
            "question": "Q5 -- Does search's available_labels predict the /download variations?",
            "derived": {
                "declared_in_search": declared,
                "actual_variation_labels": actual,
                "declared_missing_from_actual": sorted(set(declared) - set(actual)),
                "actual_missing_from_declared": sorted(set(actual) - set(declared)),
                "source_present_in_both": ("source" in declared) == ("source" in actual),
                "type": m.get("type"), "item_count": m.get("item_count"),
                "chapters_in_files": len(emb.get("files") or []),
                "variation_item_numbers": [v.get("item_number") for v in (emb.get("variations") or [])
                                           if isinstance(v, dict)],
            },
        }
        if not p.dry_run:
            print("  ..  {:<36} declared={} actual={}".format(key, len(declared), len(actual)),
                  file=sys.stderr)
        checked += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--token-file", default=TOKEN_PATH)
    args = ap.parse_args()

    token = ""
    if not args.dry_run:
        token = os.environ.get("GP_ACCESS_TOKEN", "").strip()
        if not token and os.path.exists(args.token_file):
            token = open(args.token_file).read().strip()
        if not token:
            sys.stderr.write("No token at {}\n".format(args.token_file))
            return 2

    sys.stderr.write("go2cloud follow-up probe -- READ-ONLY, max {} requests\n".format(MAX_REQUESTS))
    p = Probe(token, "", dry_run=args.dry_run)
    results = OrderedDict()
    run(p, results)

    if args.dry_run:
        sys.stderr.write("\nPlanned ({}):\n".format(len(p.planned)))
        for i, r in enumerate(p.planned, 1):
            sys.stderr.write("{:>3}. {} {}\n".format(i, r["method"], r["url"]))
        return 0

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out + ".json", "w") as fh:
        json.dump({"generated_at": datetime.now(timezone.utc).isoformat(),
                   "requests_issued": p.request_count, "probes": results}, fh, indent=2)
    sys.stderr.write("\n{} requests issued.\nWrote {}.json\n".format(p.request_count, args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
