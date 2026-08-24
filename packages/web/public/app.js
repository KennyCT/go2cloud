/**
 * go2cloud web UI.
 *
 * No build step and no framework: six views and a progress stream do not justify a
 * bundler in a tool distributed over npx. State lives in one object, the server
 * pushes progress over SSE, and rendering is a handful of direct DOM writes.
 */

const $ = (id) => document.getElementById(id);

const state = {
  rows: [],
  /** Ids the user has ticked. Empty means "everything transferable". */
  picked: new Set(),
  goproConnected: false,
  googleConnected: false,
  /** Assumed uplink for the estimate. Upload is the bottleneck, not download. */
  uplinkMbps: 40,
};

// ---- formatting ---------------------------------------------------------- //

function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 0)} ${units[i]}`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "–";
  // Round to whole minutes first; rounding the remainder alone yields "3h 60m".
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const estimate = (totalBytes) => duration((totalBytes * 8) / (state.uplinkMbps * 1e6));

// ---- starfield ----------------------------------------------------------- //

(function starfield() {
  const canvas = $("stars");
  const ctx = canvas.getContext("2d");
  let stars = [];

  function seed() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(220, Math.round((innerWidth * innerHeight) / 9000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: Math.random() * 1.25 + 0.25,
      a: Math.random() * 0.5 + 0.2,
      // Drift rate for the twinkle; slow enough not to be distracting.
      t: Math.random() * 0.012 + 0.003,
      p: Math.random() * Math.PI * 2,
    }));
  }

  function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of stars) {
      s.p += s.t;
      const alpha = s.a + Math.sin(s.p) * 0.18;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 214, 255, ${Math.max(0.05, alpha)})`;
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }

  // Respect users who have asked for less motion: draw once, do not animate.
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  addEventListener("resize", seed);
  seed();
  if (still) {
    for (const s of stars) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 214, 255, ${s.a})`;
      ctx.fill();
    }
  } else {
    frame();
  }
})();

// ---- api ----------------------------------------------------------------- //

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

function filters() {
  return {
    from: $("f-from").value || undefined,
    to: $("f-to").value || undefined,
    type: $("f-type").value || undefined,
    album: $("f-album").value || undefined,
  };
}

// ---- connection state ---------------------------------------------------- //

async function refreshState() {
  const s = await api("/api/state");
  state.goproConnected = s.gopro.connected;
  state.googleConnected = s.google.connected;

  $("dot-gopro").className = `dot ${s.gopro.connected ? "on" : "off"}`;
  $("txt-gopro").textContent = s.gopro.connected
    ? `GoPro connected · roughly ${(s.gopro.expiresInMs / 3600000).toFixed(1)}h left`
    : "GoPro not connected";

  $("dot-google").className = `dot ${s.google.connected ? "on" : "off"}`;
  $("txt-google").textContent = s.google.connected ? "Google Photos connected" : "Google Photos not connected";
  $("txt-profile").textContent = `profile: ${s.profile}`;

  const help = $("auth-help");
  const missing = [];
  if (!s.gopro.connected) missing.push("go2cloud auth gopro");
  if (!s.google.connected) missing.push(`go2cloud${s.profile === "default" ? "" : ` --profile ${s.profile}`} auth google`);
  if (missing.length) {
    help.className = "notice bad";
    help.innerHTML = `Sign in from your terminal first — the browser cannot hold your credentials:<br>` +
      missing.map((c) => `<code>${c}</code>`).join("<br>");
  } else {
    help.className = "notice hidden";
  }
  updateStartButton();
  return s;
}

function updateStartButton() {
  const ready = state.goproConnected && state.googleConnected && chosen().length > 0;
  $("btn-start").disabled = !ready;
}

// ---- library ------------------------------------------------------------- //

async function scan() {
  const btn = $("btn-scan");
  btn.disabled = true; btn.textContent = "Scanning…";
  try {
    state.rows = await api("/api/library", filters());
    // Default to everything transferable; the user narrows from there.
    state.picked = new Set(state.rows.filter((r) => !r.skip).map((r) => r.id));
    renderLibrary();
  } catch (err) {
    alert(`Scan failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = "Scan library";
  }
}

/** Rows that will actually transfer, honouring both skips and the tick boxes. */
function chosen() {
  return state.rows.filter((r) => !r.skip && state.picked.has(r.id));
}

function renderLibrary() {
  const skipped = state.rows.filter((r) => r.skip);
  const sel = chosen();
  const total = sel.reduce((n, r) => n + r.bytes, 0);

  $("s-count").textContent = String(sel.length);
  $("s-size").textContent = bytes(total);
  $("s-eta").textContent = estimate(total);
  $("s-skip").textContent = String(skipped.length);

  const shown = state.rows.slice(0, 400);
  $("lib-rows").innerHTML = shown.map((r) => {
    const on = state.picked.has(r.id);
    return `
    <tr class="${on ? "picked" : ""}" data-id="${escapeHtml(r.id)}">
      <td><input type="checkbox" data-pick="${escapeHtml(r.id)}" ${on ? "checked" : ""} ${r.skip ? "disabled" : ""}></td>
      <td class="muted">${(r.capturedAt ?? "").slice(0, 16).replace("T", " ")}</td>
      <td>${escapeHtml(r.filename)}</td>
      <td class="muted">${escapeHtml(r.type)}</td>
      <td class="num">${bytes(r.bytes)}</td>
      <td class="${r.skip ? "warn" : "muted"}">${r.skip ? escapeHtml(r.skip) : ""}</td>
    </tr>`;
  }).join("");

  const usable = state.rows.filter((r) => !r.skip).length;
  $("sel-count").textContent = `${sel.length} of ${usable} selected` +
    (state.rows.length > shown.length ? ` · showing first ${shown.length} of ${state.rows.length}` : "");
  $("sel-head").checked = sel.length > 0 && sel.length === usable;
  $("sel-head").indeterminate = sel.length > 0 && sel.length < usable;

  $("lib-wrap").classList.remove("hidden");
  updateStartButton();
}

function pick(mode) {
  const usable = state.rows.filter((r) => !r.skip);
  if (mode === "all") for (const r of usable) state.picked.add(r.id);
  else if (mode === "none") state.picked.clear();
  else for (const r of usable) state.picked.has(r.id) ? state.picked.delete(r.id) : state.picked.add(r.id);
  renderLibrary();
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- transfer ------------------------------------------------------------ //

async function start() {
  const mode = $("d-mode").value;
  const body = { ...filters(), concurrency: 3 };
  if (mode === "new") {
    const name = $("d-new").value.trim();
    if (!name) { alert("Give the album a name."); return; }
    body.newAlbum = name;
  } else if (mode === "existing") {
    body.toAlbum = $("d-existing").value;
    if (!body.toAlbum) { alert("Pick an album."); return; }
  }

  const sel = chosen();
  if (sel.length === 0) { alert("Nothing selected."); return; }
  // Send explicit ids so the server transfers the selection, not the filter.
  body.ids = sel.map((r) => r.id);

  const size = sel.reduce((n, r) => n + r.bytes, 0);
  const label = mode === "root" ? "your Google Photos library" : `“${body.newAlbum ?? $("d-existing").selectedOptions[0]?.text}”`;
  const ok = confirm(
    `Transfer ${sel.length} items (${bytes(size)}) into ${label}?\n\n` +
    `Estimated ${estimate(size)}.\n\n` +
    `This cannot be undone from here — the Google Photos API has no delete capability.`);
  if (!ok) return;

  $("btn-start").disabled = true;
  $("run-panel").classList.remove("hidden");
  $("run-panel").scrollIntoView({ behavior: "smooth" });
  try {
    await api("/api/transfer", body);
  } catch (err) {
    alert(`Could not start: ${err.message}`);
    $("btn-start").disabled = false;
  }
}

function renderJob(job) {
  if (job.phase === "idle") return;
  $("run-panel").classList.remove("hidden");
  $("r-phase").textContent = job.phase;
  $("r-done").textContent = String(job.completed);
  $("r-failed").textContent = String(job.failed);
  $("r-failed").style.color = job.failed > 0 ? "var(--rose)" : "";
  $("r-elapsed").textContent = duration(job.elapsedMs / 1000);

  const pct = job.total > 0 ? (job.completed / job.total) * 100 : 0;
  $("r-bar").style.width = `${Math.min(100, pct)}%`;

  $("r-flight").innerHTML = job.active.map((a) => `
    <div>
      <div class="name"><span>${escapeHtml(a.filename)}</span><span>${bytes(a.sent)} / ${bytes(a.total)}</span></div>
      <div class="bar"><i style="width:${a.total ? (a.sent / a.total) * 100 : 0}%"></i></div>
    </div>`).join("");

  $("r-log").textContent = job.log.join("\n");
  $("r-log").scrollTop = $("r-log").scrollHeight;

  if (job.phase === "done" || job.phase === "failed") {
    $("btn-start").disabled = false;
    refreshState().catch(() => {});
    loadHistory();
  }
}

// ---- wiring -------------------------------------------------------------- //

async function loadHistory() {
  try {
    const h = await api("/api/history");
    if (h.recent.length === 0 && h.albums.length === 0) return;
    const verified = h.recent.filter((r) => r.state === "verified");
    const bytesDone = h.days.reduce((n, d) => n + Number(d.bytes ?? 0), 0);
    $("hist-stats").innerHTML = `
      <div class="stat"><div class="k">Transferred</div><div class="v accent">${verified.length}</div></div>
      <div class="stat"><div class="k">Total moved</div><div class="v">${bytes(bytesDone)}</div></div>
      <div class="stat"><div class="k">Albums made</div><div class="v">${h.albums.length}</div></div>
      <div class="stat"><div class="k">Skipped</div><div class="v">${h.recent.filter((r) => r.state === "skipped").length}</div></div>`;
    $("hist-rows").innerHTML = h.recent.slice(0, 120).map((r) => `
      <tr>
        <td class="muted">${(r.finishedAt ?? "").slice(0, 16).replace("T", " ")}</td>
        <td>${escapeHtml(r.filename)}</td>
        <td class="${r.state === "verified" ? "ok" : r.state === "skipped" ? "warn" : "bad"}">${escapeHtml(r.state)}${r.error ? ` — ${escapeHtml(r.error.slice(0, 60))}` : ""}</td>
        <td class="num">${bytes(r.bytes)}</td>
      </tr>`).join("");
    $("hist-panel").classList.remove("hidden");
  } catch { /* history is optional context, never a blocker */ }
}

$("btn-scan").addEventListener("click", scan);
$("sel-all").addEventListener("click", () => pick("all"));
$("sel-none").addEventListener("click", () => pick("none"));
$("sel-invert").addEventListener("click", () => pick("invert"));
$("sel-head").addEventListener("change", (e) => pick(e.target.checked ? "all" : "none"));
// Delegated so re-rendering the table does not orphan listeners.
$("lib-rows").addEventListener("change", (e) => {
  const id = e.target?.dataset?.pick;
  if (!id) return;
  e.target.checked ? state.picked.add(id) : state.picked.delete(id);
  renderLibrary();
});
$("btn-start").addEventListener("click", start);
$("d-mode").addEventListener("change", () => {
  const m = $("d-mode").value;
  $("d-new-wrap").classList.toggle("hidden", m !== "new");
  $("d-existing-wrap").classList.toggle("hidden", m !== "existing");
});

new EventSource("/api/events").onmessage = (e) => {
  try { renderJob(JSON.parse(e.data)); } catch { /* keep-alive comment frames */ }
};

(async function boot() {
  await refreshState();
  loadHistory();
  // Populate the pickers, but a failure here must not blank the whole page.
  try {
    const albums = await api("/api/gopro/albums");
    $("f-album").insertAdjacentHTML("beforeend",
      albums.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.title)}</option>`).join(""));
  } catch { /* not connected yet */ }
  try {
    const albums = await api("/api/google/albums");
    $("d-existing").innerHTML = albums.length
      ? albums.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.title)} (${a.itemCount})</option>`).join("")
      : `<option value="">no go2cloud albums yet</option>`;
  } catch { /* not connected yet */ }
})();
