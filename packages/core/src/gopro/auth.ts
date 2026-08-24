/**
 * GoPro Cloud authentication.
 *
 * GoPro exposes no third-party OAuth registration, but its token endpoint is live
 * and the client credentials shipped in its own web app still authenticate
 * (verified 2026-08-23, PLAN.md §5.1). That means Playwright capture is a one-time
 * bootstrap rather than a recurring chore: after the first login we refresh.
 */

import { readJson, writeJson, deleteSecret } from "../util/keychain.js";

const ACCOUNT = "gopro";
const TOKEN_URL = "https://api.gopro.com/v1/oauth2/token";

/**
 * Credentials published in GoPro's own web client and reused by every open-source
 * GoPro Cloud tool. Not secret, and required for the refresh grant to work at all.
 */
const CLIENT_ID = "71611e67ea968cfacf45e2b6936c81156fcf5dbe553a2bf2d342da1562d05f46";
const CLIENT_SECRET = "3863c9b438c07b82f39ab3eeeef9c24fefa50c6856253e3f1d37e0e3b1ead68d";

/** Refresh this far ahead of expiry — a long upload can straddle the boundary. */
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

export interface GoProTokens {
  accessToken: string;
  refreshToken: string | null;
  /**
   * Best-effort upper bound only — NEVER trust this as validity.
   *
   * A browser-captured session cookie advertises a 168-hour expiry, but that is the
   * cookie's browser-persistence attribute, not how long GoPro honours the session.
   * Observed lifetimes are hours: one token died in about nine, another mid-session.
   * A 401 is the only authoritative signal, so the value here is capped to something
   * plausible and the 401 path drives re-authentication regardless.
   */
  expiresAt: number;
  userId: string | null;
  obtainedAt: number;
}

/**
 * How long a browser-captured session is assumed good for before we warn.
 * Deliberately conservative: over-trusting the cookie's stated expiry means telling
 * users they are connected when they are not.
 */
export const ASSUMED_SESSION_MS = 8 * 60 * 60 * 1000;

/**
 * The access token may be a JWE rather than a JWT, so its `exp` claim is not
 * readable. Expiry is tracked from the `expires_in` the server returned, and a
 * 401 is always treated as authoritative regardless of the clock.
 */
function fromTokenResponse(body: Record<string, unknown>, fallbackRefresh?: string | null): GoProTokens {
  const now = Date.now();
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
  const refresh =
    typeof body["refresh_token"] === "string" ? body["refresh_token"] : (fallbackRefresh ?? null);
  return {
    accessToken: String(body["access_token"] ?? ""),
    refreshToken: refresh,
    expiresAt: now + expiresIn * 1000,
    userId: typeof body["resource_owner_id"] === "string" ? body["resource_owner_id"] : null,
    obtainedAt: now,
  };
}

export function loadTokens(): GoProTokens | null {
  return readJson<GoProTokens>(ACCOUNT);
}

export function saveTokens(t: GoProTokens): void {
  writeJson(ACCOUNT, t);
}

export function clearTokens(): boolean {
  return deleteSecret(ACCOUNT);
}

/** Store a token captured from a browser session (the bootstrap path). */
export function saveCapturedToken(accessToken: string, userId: string | null, expiresInSeconds = 3600): void {
  saveTokens({
    accessToken,
    refreshToken: null,
    // Cap whatever the cookie claims — see the note on expiresAt.
    expiresAt: Date.now() + Math.min(expiresInSeconds * 1000, ASSUMED_SESSION_MS),
    userId,
    obtainedAt: Date.now(),
  });
}

export function isExpiring(t: GoProTokens, marginMs = REFRESH_MARGIN_MS): boolean {
  return Date.now() >= t.expiresAt - marginMs;
}

export class GoProAuthError extends Error {
  readonly needsReauth: boolean;
  constructor(message: string, needsReauth: boolean) {
    super(message);
    this.name = "GoProAuthError";
    this.needsReauth = needsReauth;
  }
}

export async function refreshTokens(current: GoProTokens): Promise<GoProTokens> {
  if (!current.refreshToken) {
    throw new GoProAuthError(
      "No refresh token — this session came from a browser capture. Run `go2cloud auth gopro` again.",
      true,
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: current.refreshToken,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = String(body["error"] ?? res.status);
    throw new GoProAuthError(`GoPro refused the refresh grant (${err}). Re-authentication required.`, true);
  }
  const next = fromTokenResponse(body, current.refreshToken);
  saveTokens(next);
  return next;
}

/**
 * Return a usable access token, refreshing pre-emptively when close to expiry.
 * Returns null when no credential exists at all, so callers can prompt for login.
 */
export async function currentAccessToken(): Promise<string | null> {
  const t = loadTokens();
  if (!t) return null;
  if (!isExpiring(t)) return t.accessToken;
  if (!t.refreshToken) return t.accessToken; // let the 401 path drive re-auth
  try {
    return (await refreshTokens(t)).accessToken;
  } catch {
    return t.accessToken;
  }
}
