/**
 * Local web server for go2cloud.
 *
 * Binds to 127.0.0.1 only. There is no authentication because there is no network
 * surface: the server exists to give the local user a nicer view of the same engine
 * the CLI drives, and it holds no credentials of its own — everything goes through
 * the OS keychain exactly as the CLI does.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  GoProClient, GooglePhotosClient, Store, TransferEngine, defaultDbPath,
  goproAuth, googleAuth, selectAssets, selectPreview, previewKind, bytesOf, thumbnailUrl,
  mimeFor, GOPRO_URL_TTL_MS, GOPRO_URL_REFRESH_MARGIN_MS,
  ORIGINAL_LABELS, PREVIEW_ORIGINAL_MAX_BYTES,
  type MediaRow, type PreviewAsset, type ProgressEvent, type TransferTask,
} from "@go2cloud/core";

const here = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  profile?: string;
  port?: number;
}

type JobPhase = "idle" | "planning" | "transferring" | "done" | "failed";

interface JobState {
  phase: JobPhase;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  bytesTotal: number;
  bytesSent: number;
  active: Map<string, { filename: string; sent: number; total: number }>;
  log: string[];
  startedAt: number | null;
  error: string | null;
}

function emptyJob(): JobState {
  return {
    phase: "idle", total: 0, completed: 0, failed: 0, skipped: 0,
    bytesTotal: 0, bytesSent: 0, active: new Map(), log: [],
    startedAt: null, error: null,
  };
}

/** Shape sent to the browser — Maps do not survive JSON. */
function serialise(job: JobState) {
  return {
    phase: job.phase,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    bytesTotal: job.bytesTotal,
    bytesSent: job.bytesSent,
    active: [...job.active.values()],
    log: job.log.slice(-40),
    startedAt: job.startedAt,
    error: job.error,
    elapsedMs: job.startedAt ? Date.now() - job.startedAt : 0,
  };
}

interface Filters {
  from?: string; to?: string; uploadedFrom?: string; uploadedTo?: string;
  type?: string; album?: string;
}

/** A signed CDN URL plus what it points at. Never persisted — it dies in an hour. */
interface StreamEntry {
  url: string;
  resolvedAt: number;
  asset: PreviewAsset;
}

/**
 * Outcome of resolving a preview. `refused` is distinct from "nothing there": the
 * caller shows the user why, which is the whole difference between a considered
 * decline and a dead player.
 */
interface Resolution {
  entry?: StreamEntry;
  refused?: string;
}

const readableBytes = (n: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

function parseDate(s: string | undefined, endOfDay = false): Date | undefined {
  if (!s) return undefined;
  const iso = s.length === 10 ? `${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function rowsFor(client: GoProClient, f: Filters): Promise<MediaRow[]> {
  const filter = {
    capturedFrom: parseDate(f.from),
    capturedTo: parseDate(f.to, true),
    createdFrom: parseDate(f.uploadedFrom),
    createdTo: parseDate(f.uploadedTo, true),
    types: f.type ? f.type.split(",").filter(Boolean) : undefined,
  };
  if (!f.album) {
    const rows: MediaRow[] = [];
    for await (const r of client.search(filter)) rows.push(r);
    return rows;
  }
  const albums = await client.albumList();
  const match = albums.find((a) => a.id === f.album) ??
    albums.find((a) => a.title.toLowerCase() === f.album?.toLowerCase());
  if (!match) throw new Error(`No GoPro album matching "${f.album}"`);
  const inRange = (iso: string | null | undefined, lo?: Date, hi?: Date) => {
    if (!lo && !hi) return true;
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return (!lo || t >= lo.getTime()) && (!hi || t <= hi.getTime());
  };
  return (await client.albumMedia(match.id)).filter(
    (r) =>
      inRange(r.captured_at, filter.capturedFrom, filter.capturedTo) &&
      inRange(r.created_at, filter.createdFrom, filter.createdTo) &&
      (!filter.types || filter.types.includes(String(r.type))),
  );
}

/** Hostnames a genuine loopback client can present. Ports are irrelevant — see the hook. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  // "[::1]:4173" keeps its brackets; "127.0.0.1:4173" splits on the colon.
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return LOOPBACK.has(name);
}

function loopbackOrigin(origin: string | undefined): boolean {
  // Same-origin GETs — including every <video> and <img> the page makes — send no
  // Origin at all. Only a cross-origin caller announces itself, and then it must be us.
  if (!origin) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Byte length of a signed CDN asset. Null when the CDN declines to say. */
async function headSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

const DENY = new Set(["360", "gpr", "lrv", "thm"]);

function skipReason(row: MediaRow): string | null {
  const ext = (row.file_extension ?? row.filename?.split(".").pop() ?? "").toLowerCase();
  if (row.play_as === "edl" && row.mce_type === "user_created") return "Quik edit project";
  if (DENY.has(ext)) return `Google Photos cannot read .${ext}`;
  const labels = row.available_labels ?? [];
  if (labels.length > 0 && !labels.some((l) => l === "source" || l === "baked_source")) {
    return "no original available";
  }
  return null;
}

export async function createServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const profile = opts.profile ?? "default";
  const app = Fastify({ logger: false });
  const job = emptyJob();

  /**
   * Thumbnails are proxied rather than linked.
   *
   * GoPro's image CDN requires the account bearer token, which the browser does not
   * and should not have, so the server fetches them. Tokens are kept here rather
   * than sent to the page for the same reason. Bytes are cached because a grid
   * re-renders on every selection change and re-fetching 61 images each time would
   * be absurd; ~29 KB each keeps the whole cache trivial.
   */
  const thumbTokens = new Map<string, string>();
  const thumbCache = new Map<string, Buffer>();
  const THUMB_CACHE_MAX = 400;

  /**
   * Rows from the last scan, and the signed CDN URLs resolved from them.
   *
   * Previewing needs the row (to tell footage from a still) and a URL that only
   * /media/{id}/download can mint. Both are held here rather than sent to the page:
   * a signed URL is a bearer credential for that file, and it dies after an hour,
   * so a browser holding one would break mid-scrub with no way to renew it. The
   * server re-resolves instead — see PLAN.md §7.2.
   *
   * These describe ONE scan and are replaced wholesale by the next, which is what
   * keeps them bounded. An earlier version evicted oldest-first while ingesting, and
   * on a library past ROWS_MAX that threw away the head of the scan being ingested —
   * exactly the rows the grid goes on to render.
   */
  const rowsById = new Map<string, MediaRow>();
  const ROWS_MAX = 5000;
  const streamUrls = new Map<string, StreamEntry>();
  const listeners = new Set<(chunk: string) => void>();

  /**
   * Binding to loopback is not, by itself, a security boundary.
   *
   * Any page on any website can issue requests to 127.0.0.1, and DNS rebinding lets it
   * do so as same-origin — the attacker serves from a host whose record flips to
   * 127.0.0.1 after load. That was already worth closing when the API only exposed
   * library metadata; now that previews serve full-resolution photos and video bytes,
   * it would hand a malicious page the user's footage.
   *
   * A browser cannot be stopped from connecting, but it cannot lie about these two
   * headers either: Host still carries the attacker's own hostname, and any genuinely
   * cross-origin request carries an Origin. Checking both costs nothing.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!loopbackHost(req.headers.host) || !loopbackOrigin(req.headers.origin)) {
      return reply.code(403).send({
        error: "go2cloud only answers requests addressed to it as localhost.",
      });
    }
    return;
  });

  const broadcast = () => {
    const payload = `data: ${JSON.stringify(serialise(job))}\n\n`;
    for (const send of listeners) send(payload);
  };
  const note = (m: string) => { job.log.push(m); broadcast(); };

  await app.register(fastifyStatic, { root: join(here, "..", "public") });

  app.get("/api/state", async () => {
    const gp = goproAuth.loadTokens();
    const gc = googleAuth.loadConfig();
    const gt = googleAuth.loadTokens(profile);
    let googleOk = false;
    if (gc && gt) {
      try { await googleAuth.accessToken(profile); googleOk = true; } catch { googleOk = false; }
    }
    const store = new Store(defaultDbPath(profile));
    const summary = store.summary();
    store.close();
    return {
      profile,
      // `stale` rather than disconnected: only a 401 is authoritative about a GoPro
      // session (see gopro/auth.ts), but a credential past its own stated expiry
      // should not be reported as healthy with a negative countdown.
      gopro: gp
        ? { connected: true, expiresInMs: gp.expiresAt - Date.now(), stale: gp.expiresAt <= Date.now() }
        : { connected: false, stale: false },
      google: { connected: googleOk, configured: Boolean(gc) },
      history: summary,
      job: serialise(job),
    };
  });

  app.get("/api/gopro/albums", async () => new GoProClient().albumList());

  app.get("/api/history", async () => {
    const store = new Store(defaultDbPath(profile));
    try {
      const albums = store.googleAlbums();
      return {
        days: store.transferDays(),
        albums,
        recent: store.recentTransfers(120).map((t) => ({
          id: `${t.gopro_media_id}#${t.item_number}`,
          filename: t.filename ?? t.gopro_media_id,
          state: t.state,
          bytes: t.bytes_total,
          finishedAt: t.finished_at,
          error: t.last_error,
        })),
      };
    } finally {
      store.close();
    }
  });

  app.get("/api/google/albums", async () => {
    const albums = await new GooglePhotosClient(profile).listAlbums();
    return albums.filter((a) => a.writeable);
  });

  app.post<{ Body: Filters }>("/api/library", async (req) => {
    const rows = await rowsFor(new GoProClient(), req.body ?? {});

    // Replace, never accumulate. Keep the HEAD of the scan when it overruns the cap,
    // because the grid renders the first 400 rows — retaining the tail would leave
    // every visible card's preview 404ing while its thumbnail loaded perfectly.
    rowsById.clear();
    thumbTokens.clear();
    streamUrls.clear();
    for (const r of rows.slice(0, ROWS_MAX)) {
      if (typeof r.token === "string") thumbTokens.set(r.id, r.token);
      rowsById.set(r.id, r);
    }
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename ?? "(untitled)",
      type: r.type ?? "?",
      bytes: bytesOf(r),
      capturedAt: r.captured_at ?? null,
      itemCount: r.item_count ?? 1,
      // source_duration is milliseconds as a string in live data.
      durationMs: typeof r.source_duration === "number" ? r.source_duration : null,
      hasThumb: typeof r.token === "string",
      kind: previewKind(r),
      skip: skipReason(r),
    }));
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>(
    "/api/thumb/:id",
    async (req, reply) => {
      const id = req.params.id;
      // `original` is a full-resolution still — the photo preview. Only the small
      // one is cached; caching originals would trade megabytes for a rare hit.
      const full = req.query.size === "original";
      const cached = full ? undefined : thumbCache.get(id);
      if (cached) return reply.type("image/jpeg").header("Cache-Control", "private, max-age=3600").send(cached);

      const token = thumbTokens.get(id);
      if (!token) return reply.code(404).send({ error: "unknown media id — scan first" });

      const access = await goproAuth.currentAccessToken();
      if (!access) return reply.code(401).send({ error: "not signed in to GoPro" });

      // Spread across GoPro's four image hosts, as their own client does.
      const shard = [...id].reduce((n, c) => n + c.charCodeAt(0), 0);
      const res = await fetch(thumbnailUrl(token, shard, full ? "original" : "450w"), {
        headers: { Authorization: `Bearer ${access}` },
      });
      if (!res.ok) return reply.code(502).send({ error: `thumbnail unavailable (${res.status})` });

      const buf = Buffer.from(await res.arrayBuffer());
      if (!full) {
        if (thumbCache.size >= THUMB_CACHE_MAX) {
          const oldest = thumbCache.keys().next().value;
          if (oldest !== undefined) thumbCache.delete(oldest);
        }
        thumbCache.set(id, buf);
      }
      return reply.type("image/jpeg").header("Cache-Control", "private, max-age=3600").send(buf);
    },
  );

  /**
   * Mint a fresh signed CDN URL for a video's preview rendition. One API call.
   *
   * `pin` matters on renewal. A browser's byte offsets only mean anything against the
   * file it started with, so re-resolving mid-stream must land on the SAME
   * (label, item_number). Without the pin, a change in what GoPro reports available
   * could hand back a different rendition and splice two files together at the current
   * offset. The transfer engine pins the same way for the same reason (PLAN.md §7.2).
   */
  async function resolveStream(id: string, pin?: PreviewAsset): Promise<Resolution> {
    const row = rowsById.get(id);
    if (!row) return {};
    const manifest = await new GoProClient().downloadManifest(id);
    const chosen = selectPreview(row, manifest);
    if (!chosen) return {};

    let asset = chosen;
    if (pin && (chosen.label !== pin.label || chosen.itemNumber !== pin.itemNumber)) {
      const same = (manifest._embedded.variations ?? []).find(
        (v) =>
          String(v.label ?? "unknown") === pin.label &&
          (v.item_number ?? 1) === pin.itemNumber &&
          v.available !== false &&
          typeof v.url === "string" && v.url.length > 0,
      );
      // Refuse rather than splice: a truncated preview is recoverable, a corrupt one is confusing.
      if (!same) return {};
      asset = { ...pin, url: same.url as string };
    }

    // Falling back to an original means every second watched pulls full-quality bytes.
    // The manifest carries no size, so ask the CDN — but only on this rare path, and
    // only once per resolve, since seeking reuses the cached entry.
    if ((ORIGINAL_LABELS as readonly string[]).includes(asset.label)) {
      const size = await headSize(asset.url);
      if (size !== null && size > PREVIEW_ORIGINAL_MAX_BYTES) {
        return {
          refused:
            `GoPro has produced no preview rendition for this clip, and the original is ` +
            `${readableBytes(size)} — previewing it would stream the full-quality file.`,
        };
      }
    }

    const entry = { url: asset.url, resolvedAt: Date.now(), asset };
    streamUrls.set(id, entry);
    return { entry };
  }

  /**
   * What the viewer should show for one item, without committing to fetching it.
   *
   * Stills come straight off the image CDN at full size — the token is already in
   * hand from the scan, so a photo preview costs no API call at all. Video needs
   * /media/{id}/download to mint a signed URL, which is why only this route pays
   * for one, and only when something is actually opened.
   */
  app.get<{ Params: { id: string } }>("/api/preview/:id", async (req, reply) => {
    const id = req.params.id;
    const row = rowsById.get(id);
    if (!row) return reply.code(404).send({ error: "unknown media id — scan first" });

    const common = {
      filename: row.filename ?? "(untitled)",
      capturedAt: row.captured_at ?? null,
      bytes: bytesOf(row),
      poster: thumbTokens.has(id) ? `/api/thumb/${encodeURIComponent(id)}` : null,
    };

    // If it cannot be transferred there is nothing to decide, so there is nothing to
    // preview — spending a manifest call and CDN bandwidth on it would be waste. The
    // card still carries the reason on its face.
    const skip = skipReason(row);
    if (skip) return { kind: "none", note: `Not transferable — ${skip}.`, ...common };

    if (previewKind(row) === "photo") {
      if (!thumbTokens.has(id)) return { kind: "none", note: "GoPro has no preview for this item.", ...common };
      return {
        kind: "photo",
        src: `/api/thumb/${encodeURIComponent(id)}?size=original`,
        width: row.width ?? null,
        height: row.height ?? null,
        ...common,
      };
    }

    const resolved = await resolveStream(id);
    if (resolved.refused) return { kind: "none", note: resolved.refused, ...common };
    if (!resolved.entry) {
      return {
        kind: "none",
        note: row.ready_to_view && row.ready_to_view !== "ready"
          ? "GoPro is still processing this clip — no preview yet."
          : "GoPro has produced no playable rendition of this clip.",
        ...common,
      };
    }
    const { asset } = resolved.entry;
    return {
      kind: "video",
      src: `/api/stream/${encodeURIComponent(id)}`,
      width: asset.width,
      height: asset.height,
      label: asset.label,
      chapters: asset.chapters,
      durationMs: typeof row.source_duration === "number" ? row.source_duration : null,
      ...common,
    };
  });

  /**
   * Byte pipe from the CDN to the <video> element.
   *
   * Proxied rather than redirected for three reasons: the CDN answers
   * `binary/octet-stream` for everything, which browsers will not play; the signed
   * URL is a credential that has no business in the page; and it expires after an
   * hour, so a long scrub session would break with the page unable to renew it.
   * Range headers pass through untouched, which is what makes seeking work, and the
   * body is piped rather than buffered so a 4 GB clip costs a socket, not memory.
   */
  app.get<{ Params: { id: string } }>("/api/stream/:id", async (req, reply) => {
    const id = req.params.id;
    const row = rowsById.get(id);
    if (!row) return reply.code(404).send({ error: "unknown media id — scan first" });
    // Same gate as /api/preview, so the byte route cannot be reached around it.
    const skipped = skipReason(row);
    if (skipped) return reply.code(404).send({ error: `not transferable — ${skipped}` });

    let entry = streamUrls.get(id);
    const stale = entry && Date.now() - entry.resolvedAt >= GOPRO_URL_TTL_MS - GOPRO_URL_REFRESH_MARGIN_MS;
    if (!entry || stale) {
      const resolved = await resolveStream(id, entry?.asset);
      if (resolved.refused) return reply.code(413).send({ error: resolved.refused });
      entry = resolved.entry;
    }
    if (!entry) return reply.code(404).send({ error: "no playable rendition for this item" });

    // Seeking abandons the previous request; without this the upstream fetch would
    // keep pulling bytes nobody will read.
    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());

    const range = req.headers.range;
    const pull = (url: string) =>
      fetch(url, { headers: range ? { Range: range } : {}, signal: abort.signal });

    let res: Response;
    try {
      res = await pull(entry.url);
      // 403 is how the CDN reports an expired signature; re-mint once and retry.
      if (res.status === 403 || res.status === 401) {
        const fresh = await resolveStream(id, entry.asset);
        if (!fresh.entry) return reply.code(502).send({ error: "preview URL expired and could not be renewed" });
        res = await pull(fresh.entry.url);
      }
    } catch (err) {
      if (abort.signal.aborted) return reply.hijack();
      return reply.code(502).send({ error: `preview unavailable: ${String(err)}` });
    }

    if (!res.ok && res.status !== 206) {
      return reply.code(502).send({ error: `preview unavailable (${res.status})` });
    }

    reply.code(res.status === 206 ? 206 : 200);
    // From the rendition's own container, never the medium's filename — see PreviewAsset.
    reply.header("Content-Type", mimeFor(`preview.${entry.asset.container}`));
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "private, no-store");
    const length = res.headers.get("content-length");
    if (length) reply.header("Content-Length", length);
    const contentRange = res.headers.get("content-range");
    if (contentRange) reply.header("Content-Range", contentRange);

    if (!res.body) return reply.send();
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    // A seek aborts mid-pipe; that is normal, not an error worth surfacing.
    body.on("error", () => body.destroy());
    return reply.send(body);
  });

  app.post<{ Body: Filters & { ids?: string[]; newAlbum?: string; toAlbum?: string; concurrency?: number } }>(
    "/api/transfer",
    async (req, reply) => {
      if (job.phase === "planning" || job.phase === "transferring") {
        return reply.code(409).send({ error: "A transfer is already running." });
      }
      const body = req.body ?? {};
      Object.assign(job, emptyJob(), { phase: "planning" as JobPhase, startedAt: Date.now() });
      broadcast();

      // Run detached: the HTTP request returns immediately and the browser follows
      // progress over SSE rather than holding a connection open for hours.
      void (async () => {
        const store = new Store(defaultDbPath(profile));
        const gopro = new GoProClient({ onWarn: note });
        const google = new GooglePhotosClient(profile);
        try {
          let rows = await rowsFor(gopro, body);
          if (body.ids?.length) {
            const wanted = new Set(body.ids);
            rows = rows.filter((r) => wanted.has(r.id));
          }
          store.upsertMedia(rows as unknown as Array<Record<string, unknown>>);

          const tasks: TransferTask[] = [];
          for (const row of rows) {
            const reason = skipReason(row);
            if (reason) { store.markSkipped(row.id, 1, reason); job.skipped++; continue; }
            const manifest = await gopro.downloadManifest(row.id);
            const selection = selectAssets(row, manifest);
            if (selection.warning) note(selection.warning);
            if (selection.skip) { store.markSkipped(row.id, 1, selection.skip); job.skipped++; continue; }
            for (const asset of selection.assets) {
              if (store.isDone(row.id, asset.itemNumber)) continue;
              tasks.push({ row, asset });
            }
          }

          if (tasks.length === 0) {
            job.phase = "done";
            note("Nothing left to transfer — everything matching is already in Google Photos.");
            store.close();
            return;
          }

          // Only create an album once there is something to put in it: Google Photos
          // cannot delete albums, so an empty one would be permanent.
          let albumId: string | null = body.toAlbum ?? null;
          if (body.newAlbum) {
            const existing = (await google.listAlbums()).find((a) => a.title === body.newAlbum && a.writeable);
            if (existing) { albumId = existing.id; note(`Adding to existing album "${existing.title}"`); }
            else {
              const created = await google.createAlbum(body.newAlbum);
              store.rememberGoogleAlbum(created.id, created.title);
              albumId = created.id;
              note(`Created album "${created.title}"`);
            }
          }

          for (const t of tasks) store.enqueue(t.row.id, t.asset.itemNumber, t.asset.label, albumId, bytesOf(t.row));
          job.total = tasks.length;
          job.bytesTotal = tasks.reduce((n, t) => n + bytesOf(t.row), 0);
          job.phase = "transferring";
          broadcast();

          const engine = new TransferEngine(gopro, google, store, {
            concurrency: body.concurrency ?? 3,
            albumId,
            onLog: note,
            onProgress: (e: ProgressEvent) => {
              const key = `${e.mediaId}#${e.itemNumber}`;
              if (e.phase === "uploading") {
                job.active.set(key, { filename: e.filename, sent: e.bytesSent, total: e.bytesTotal });
              } else if (e.phase === "done") {
                job.active.delete(key); job.completed++;
              } else if (e.phase === "failed") {
                job.active.delete(key); job.failed++;
                job.log.push(`Failed: ${e.filename} — ${e.message ?? ""}`);
              } else if (e.phase === "skipped") {
                job.active.delete(key); job.skipped++;
              }
              job.bytesSent = [...job.active.values()].reduce((n, a) => n + a.sent, 0);
              broadcast();
            },
          });
          const result = await engine.run(tasks);
          job.completed = result.created;
          job.failed = result.failed;
          job.phase = "done";
          note(`Finished — ${result.created} created, ${result.skipped} skipped, ${result.failed} failed.`);
        } catch (err) {
          job.phase = "failed";
          job.error = err instanceof Error ? err.message : String(err);
          note(`Error: ${job.error}`);
        } finally {
          store.close();
          broadcast();
        }
      })();

      return { started: true };
    },
  );

  app.get("/api/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (chunk: string) => reply.raw.write(chunk);
    listeners.add(send);
    send(`data: ${JSON.stringify(serialise(job))}\n\n`);
    // Comment frames keep proxies and browsers from closing an idle stream.
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => { clearInterval(keepAlive); listeners.delete(send); });
  });

  return app;
}

export async function startServer(opts: ServerOptions = {}): Promise<string> {
  const app = await createServer(opts);
  const port = opts.port ?? 4173;
  // Loopback only — never expose a credential-bearing engine to the network.
  await app.listen({ port, host: "127.0.0.1" });
  return `http://127.0.0.1:${port}`;
}
