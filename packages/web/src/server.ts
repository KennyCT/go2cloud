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
import {
  GoProClient, GooglePhotosClient, Store, TransferEngine, defaultDbPath,
  goproAuth, googleAuth, selectAssets, bytesOf,
  type MediaRow, type ProgressEvent, type TransferTask,
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
  const listeners = new Set<(chunk: string) => void>();

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
      gopro: gp ? { connected: true, expiresInMs: gp.expiresAt - Date.now() } : { connected: false },
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
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename ?? "(untitled)",
      type: r.type ?? "?",
      bytes: bytesOf(r),
      capturedAt: r.captured_at ?? null,
      itemCount: r.item_count ?? 1,
      skip: skipReason(r),
    }));
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
