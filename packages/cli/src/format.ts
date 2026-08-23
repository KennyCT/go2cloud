/** Terminal formatting helpers. No dependencies — the CLI stays small. */

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 0)} ${units[i]}`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Estimate wall-clock from bytes and an assumed uplink, since upload is the floor. */
export function estimate(totalBytes: number, mbps: number): string {
  return duration((totalBytes * 8) / (mbps * 1_000_000));
}

export function bar(fraction: number, width = 24): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
