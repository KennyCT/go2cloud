#!/usr/bin/env node
/**
 * go2cloud CLI.
 *
 * Thin adapter over @go2cloud/core — all behaviour and its justification live
 * there and in docs/PLAN.md.
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  GoProClient, GooglePhotosClient, Store, TransferEngine,
  goproAuth, googleAuth, selectAssets, bytesOf, mimeFor,
  type MediaRow, type TransferTask,
} from "@go2cloud/core";
import { bytes, estimate, bar } from "./format.js";

const program = new Command();
program.name("go2cloud").description("Stream GoPro Cloud media into Google Photos").version("0.1.0");

const out = (s = "") => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function parseDate(s: string | undefined, endOfDay = false): Date | undefined {
  if (!s) return undefined;
  // A zero-width captured_range returns nothing, so an end date means end-of-day.
  const iso = s.length === 10 ? `${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : s;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

// ---- auth ----------------------------------------------------------------- //

const auth = program.command("auth").description("connect your accounts");

auth
  .command("gopro")
  .description("connect GoPro Cloud")
  .option("--paste", "import a token you copied from the browser")
  .option("--token-file <path>", "read the token from a file", join(homedir(), ".go2cloud", "probe_token"))
  .action((o: { paste?: boolean; tokenFile: string }) => {
    if (!o.paste) {
      err("Browser login is not wired up yet (M1). For now use:\n  go2cloud auth gopro --paste");
      process.exitCode = 1;
      return;
    }
    const token = readFileSync(o.tokenFile, "utf8").trim();
    if (!token) throw new Error(`${o.tokenFile} is empty`);
    goproAuth.saveCapturedToken(token, null, 3600);
    out(`Stored a GoPro token in your OS keychain (from ${o.tokenFile}).`);
    out("Captured tokens cannot be refreshed, so this expires in about an hour.");
  });

auth
  .command("google")
  .description("connect Google Photos")
  .option("--setup <clientJson>", "path to the OAuth client JSON downloaded from Google Cloud")
  .action(async (o: { setup?: string }) => {
    const cfg = o.setup ? googleAuth.loadClientConfig(o.setup) : googleAuth.loadConfig();
    if (!cfg) {
      err("No OAuth client configured. See docs/SETUP-GOOGLE.md, then:");
      err("  go2cloud auth google --setup ~/.go2cloud/google_client_test.json");
      process.exitCode = 1;
      return;
    }
    out("Opening the consent screen. Expect \"Google hasn't verified this app\" —");
    out("that is your own project. Click Advanced → Go to go2cloud.\n");
    await googleAuth.authorize(cfg, openBrowser);
    out("Connected to Google Photos.");
  });

auth
  .command("status")
  .description("show connection status")
  .action(async () => {
    const gp = goproAuth.loadTokens();
    if (!gp) out("GoPro   : not connected");
    else {
      const mins = Math.round((gp.expiresAt - Date.now()) / 60000);
      out(`GoPro   : connected (${mins > 0 ? `expires in ${mins}m` : "EXPIRED"}${gp.refreshToken ? ", auto-refresh on" : ", no refresh token"})`);
    }
    const gc = googleAuth.loadConfig();
    const gt = googleAuth.loadTokens();
    if (!gc || !gt) out("Google  : not connected");
    else {
      try {
        await googleAuth.accessToken();
        out("Google  : connected");
      } catch (e) {
        out(`Google  : token problem — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

// ---- library -------------------------------------------------------------- //

interface Filters { from?: string; to?: string; uploadedFrom?: string; uploadedTo?: string; type?: string }

function filterFrom(o: Filters) {
  return {
    capturedFrom: parseDate(o.from), capturedTo: parseDate(o.to, true),
    createdFrom: parseDate(o.uploadedFrom), createdTo: parseDate(o.uploadedTo, true),
    types: o.type ? o.type.split(",") : undefined,
  };
}

function withFilters(cmd: Command): Command {
  return cmd
    .option("--from <date>", "captured on or after (YYYY-MM-DD)")
    .option("--to <date>", "captured on or before (YYYY-MM-DD)")
    .option("--uploaded-from <date>", "uploaded to GoPro Cloud on or after")
    .option("--uploaded-to <date>", "uploaded to GoPro Cloud on or before")
    .option("--type <types>", "comma-separated media types, e.g. Video,Photo");
}

withFilters(program.command("scan").description("index your GoPro library into local state"))
  .action(async (o: Filters) => {
    const store = new Store();
    const client = new GoProClient({ onWarn: (m) => err(`  ! ${m}`) });
    const rows: MediaRow[] = [];
    for await (const r of client.search(filterFrom(o))) {
      rows.push(r);
      if (rows.length % 50 === 0) process.stderr.write(`\r  scanned ${rows.length}…`);
    }
    process.stderr.write("\r");
    store.upsertMedia(rows as unknown as Array<Record<string, unknown>>);
    out(`Indexed ${rows.length} items (${bytes(rows.reduce((n, r) => n + bytesOf(r), 0))}).`);
    store.close();
  });

withFilters(program.command("ls").description("list matching media"))
  .option("--limit <n>", "max rows to show", "40")
  .action(async (o: Filters & { limit: string }) => {
    const client = new GoProClient({ onWarn: (m) => err(`  ! ${m}`) });
    let shown = 0, total = 0, size = 0;
    for await (const r of client.search(filterFrom(o))) {
      total++; size += bytesOf(r);
      if (shown < Number(o.limit)) {
        out(`  ${(r.captured_at ?? "").slice(0, 19).padEnd(20)} ${(r.type ?? "?").padEnd(14)} ${(r.filename ?? r.id).padEnd(20)} ${bytes(bytesOf(r)).padStart(10)}`);
        shown++;
      }
    }
    if (total > shown) out(`  … ${total - shown} more`);
    out(`\n${total} items, ${bytes(size)}`);
  });

program
  .command("albums")
  .description("list your GoPro albums")
  .action(async () => {
    const client = new GoProClient();
    const res = await client.albums();
    const items = (res.items ?? []).filter((i) => i.type === "collection");
    if (items.length === 0) { out("No albums found."); return; }
    for (const a of items) out(`  ${(a.id ?? "").padEnd(38)} ${a.title ?? "(untitled)"}`);
    out(`\n${items.length} albums`);
  });


// ---- transfer -------------------------------------------------------------- //

interface PlanRow { row: MediaRow; skip: string | null }

/**
 * Build a plan without resolving every manifest. `available_labels` from the search
 * row is a superset of the /download variation labels, so it answers "does this have
 * an original?" for free — one saved request per item during planning.
 */
function planFrom(rows: MediaRow[]): PlanRow[] {
  const DENY = new Set(["360", "gpr", "lrv", "thm"]);
  return rows.map((row) => {
    const ext = (row.file_extension ?? row.filename?.split(".").pop() ?? "").toLowerCase();
    if (row.play_as === "edl" && row.mce_type === "user_created") return { row, skip: "Quik edit project" };
    if (DENY.has(ext)) return { row, skip: `Google Photos cannot read .${ext}` };
    const labels = row.available_labels ?? [];
    if (labels.length > 0 && !labels.some((l) => l === "source" || l === "baked_source")) {
      return { row, skip: "no original available, only proxies" };
    }
    return { row, skip: null };
  });
}

function preflight(plan: PlanRow[], albumLabel: string, mbps: number): number {
  const go = plan.filter((p) => !p.skip);
  const skipped = plan.filter((p) => p.skip);
  const totalBytes = go.reduce((n, p) => n + bytesOf(p.row), 0);

  out("");
  out("  Pre-flight");
  out("  " + "─".repeat(58));
  out(`  Items to transfer      ${String(go.length).padStart(6)}`);
  out(`  Total size             ${bytes(totalBytes).padStart(10)}`);
  out(`  Estimated duration     ~${estimate(totalBytes, mbps)}  at ${mbps} Mbps upload`);
  out(`  Google storage impact  ${bytes(totalBytes).padStart(10)}  (uploads are always original quality)`);
  out(`  Destination            ${albumLabel}`);
  if (skipped.length > 0) {
    out("");
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.skip as string, (byReason.get(s.skip as string) ?? 0) + 1);
    out(`  Skipping ${skipped.length} items:`);
    for (const [reason, n] of byReason) out(`    ${String(n).padStart(3)} x ${reason}`);
  }
  out("");
  out("  Note: Google Photos cannot delete media via API. Anything transferred");
  out("  must be removed by hand in the Photos app.");
  out("");
  return totalBytes;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(String(d).trim()));
    });
  });
}

withFilters(program.command("transfer").description("stream matching media into Google Photos"))
  .option("--new-album <title>", "create a Google Photos album and upload into it")
  .option("--to-album <id>", "upload into an album go2cloud created earlier")
  .option("--dry-run", "show the plan and stop")
  .option("--yes", "skip the confirmation prompt")
  .option("--concurrency <n>", "files in flight", "3")
  .option("--uplink <mbps>", "assumed upload speed, for the estimate only", "40")
  .action(async (o: Filters & {
    newAlbum?: string; toAlbum?: string; dryRun?: boolean; yes?: boolean;
    concurrency: string; uplink: string;
  }) => {
    const store = new Store();
    const gopro = new GoProClient({ onWarn: (m) => err(`  ! ${m}`) });
    const google = new GooglePhotosClient();

    const rows: MediaRow[] = [];
    for await (const r of gopro.search(filterFrom(o))) rows.push(r);
    if (rows.length === 0) { out("Nothing matched those filters."); store.close(); return; }
    store.upsertMedia(rows as unknown as Array<Record<string, unknown>>);

    const plan = planFrom(rows);
    const label = o.newAlbum ? `new album "${o.newAlbum}"` : o.toAlbum ? `album ${o.toAlbum}` : "Google Photos library (no album)";
    preflight(plan, label, Number(o.uplink));

    if (o.dryRun) { out("  Dry run — nothing was transferred."); store.close(); return; }
    if (!o.yes && !(await confirm("  Continue? [y/N] "))) { out("\n  Cancelled."); store.close(); return; }

    let albumId: string | null = o.toAlbum ?? null;
    if (o.newAlbum) {
      const album = await google.createAlbum(o.newAlbum);
      store.rememberGoogleAlbum(album.id, album.title);
      albumId = album.id;
      out(`\n  Created album "${album.title}"`);
    }

    // Resolve manifests only for what we will actually send.
    const tasks: TransferTask[] = [];
    for (const p of plan) {
      if (p.skip) { store.markSkipped(p.row.id, 1, p.skip); continue; }
      const manifest = await gopro.downloadManifest(p.row.id);
      const selection = selectAssets(p.row, manifest);
      if (selection.warning) err(`  ! ${selection.warning}`);
      if (selection.skip) { store.markSkipped(p.row.id, 1, selection.skip); continue; }
      for (const asset of selection.assets) {
        if (store.isDone(p.row.id, asset.itemNumber)) continue;
        store.enqueue(p.row.id, asset.itemNumber, asset.label, albumId, bytesOf(p.row));
        tasks.push({ row: p.row, asset });
      }
    }

    out(`  Transferring ${tasks.length} assets…\n`);
    const started = Date.now();
    let lastLine = 0;
    const engine = new TransferEngine(gopro, google, store, {
      concurrency: Number(o.concurrency),
      albumId,
      onLog: (m) => err(`  ! ${m}`),
      onProgress: (e) => {
        if (e.phase === "uploading" && e.bytesTotal > 0) {
          const now = Date.now();
          if (now - lastLine < 250) return;
          lastLine = now;
          process.stderr.write(`\r  ${bar(e.bytesSent / e.bytesTotal)} ${e.filename.padEnd(18)} ${bytes(e.bytesSent)}/${bytes(e.bytesTotal)}   `);
        } else if (e.phase === "done") {
          process.stderr.write(`\r  ✓ ${e.filename}${" ".repeat(40)}\n`);
        } else if (e.phase === "failed") {
          process.stderr.write(`\r  ✗ ${e.filename}: ${e.message ?? ""}\n`);
        }
      },
    });
    const result = await engine.run(tasks);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    out(`\n  Done in ${mins}m — ${result.created} created, ${result.skipped} skipped, ${result.failed} failed.`);
    store.close();
  });

program
  .command("status")
  .description("show transfer progress")
  .action(() => {
    const store = new Store();
    const summary = store.summary();
    if (Object.keys(summary).length === 0) out("Nothing queued yet.");
    else {
      for (const [state, n] of Object.entries(summary)) out(`  ${state.padEnd(10)} ${n}`);
      const remaining = store.bytesRemaining();
      if (remaining > 0) out(`\n  ${bytes(remaining)} remaining`);
    }
    store.close();
  });

export { program };

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parseAsync(process.argv).catch((e: unknown) => {
    err(`\nError: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
