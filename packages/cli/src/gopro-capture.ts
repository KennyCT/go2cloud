/**
 * GoPro login via a real browser.
 *
 * Findings from live runs on 2026-08-23:
 *   - GoPro's web login is a server-side form POST to gopro.com/login that sets a
 *     cookie. It never calls the OAuth token endpoint, so NO refresh token is
 *     obtainable this way. That endpoint is real but serves the mobile apps, and
 *     reaching it requires the password grant, which go2cloud deliberately avoids.
 *   - The session cookie is valid for 168 hours. Weekly sign-in, not hourly.
 *
 * GoPro offers no third-party OAuth registration, so there is no consent screen we
 * can send a user to. Instead we open GoPro's own login page in an isolated browser
 * context and let the user sign in themselves — password, 2FA, captcha and all.
 * Nothing they type passes through go2cloud.
 *
 * The important part is WHAT we capture. Reading the `gp_access_token` cookie yields
 * an access token with no refresh token, which dies in about an hour and forces the
 * user to log in again. Watching the network for GoPro's own token-endpoint response
 * instead yields the full bundle including `refresh_token`, after which go2cloud can
 * refresh indefinitely and the user never logs in again.
 *
 * The cookie is kept only as a fallback for when that response is never seen.
 */

import { chromium, type BrowserContext } from "playwright";

const LOGIN_URL = "https://gopro.com/media-library";
const TOKEN_ENDPOINT = /\/v[0-9]+\/oauth2\/token/;
const COOKIE_NAME = "gp_access_token";
const USER_ID_COOKIE = "gp_user_id";

export interface CapturedSession {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  userId: string | null;
  /** How we got it — determines whether unattended refresh is possible. */
  source: "token-endpoint" | "cookie";
  /** Auth-ish endpoints seen during login, for diagnosing a missing refresh token. */
  observedAuthUrls?: string[];
}

interface CookieState {
  token: string | null;
  userId: string | null;
  /** Seconds until the cookie itself expires — the real lifetime, not a guess. */
  expiresInSeconds: number | null;
}

async function readCookies(ctx: BrowserContext): Promise<CookieState> {
  const cookies = await ctx.cookies();
  const tokenCookie = cookies.find((c) => c.name === COOKIE_NAME);
  const expires = tokenCookie?.expires ?? -1;
  return {
    token: tokenCookie?.value ?? null,
    userId: cookies.find((c) => c.name === USER_ID_COOKIE)?.value ?? null,
    // Playwright reports -1 for a session cookie, which has no stated lifetime.
    expiresInSeconds: expires > 0 ? Math.max(0, Math.floor(expires - Date.now() / 1000)) : null,
  };
}

export interface CaptureOptions {
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

export async function captureGoProSession(opts: CaptureOptions = {}): Promise<CapturedSession> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const status = opts.onStatus ?? (() => {});

  const browser = await chromium.launch({ headless: false });
  // A fresh context every time: no profile is persisted, and it is destroyed below.
  const context = await browser.newContext();
  const state: { captured: CapturedSession | null } = { captured: null };

  const authUrls: string[] = [];

  context.on("response", (res) => {
    const url = res.url();
    const isStaticAsset = /\.(js|css|woff2?|png|svg|jpg|ico|map)(\?|$)/i.test(url) || /static\./i.test(url);
    const looksAuthy = !isStaticAsset && (TOKEN_ENDPOINT.test(url) || /oauth|token|login|auth|session/i.test(url));
    if (!looksAuthy) return;
    if (authUrls.length < 40 && !authUrls.includes(url)) authUrls.push(url.split("?")[0] ?? url);
    if (state.captured?.refreshToken) return;
    void res
      .json()
      .then((body: unknown) => {
        if (state.captured?.refreshToken || typeof body !== "object" || body === null) return;
        const b = body as Record<string, unknown>;
        if (typeof b["access_token"] !== "string") return;
        state.captured = {
          accessToken: b["access_token"],
          refreshToken: typeof b["refresh_token"] === "string" ? b["refresh_token"] : null,
          expiresInSeconds: typeof b["expires_in"] === "number" ? b["expires_in"] : 3600,
          userId: typeof b["resource_owner_id"] === "string" ? b["resource_owner_id"] : null,
          source: "token-endpoint",
        };
        status(
          b["refresh_token"]
            ? "Captured a full token bundle — automatic refresh is available."
            : "Saw a token response, but it carried no refresh_token.",
        );
      })
      .catch(() => {
        /* not JSON, or the body was already consumed — the cookie fallback covers it */
      });
  });

  try {
    status("Opening GoPro's login page. Sign in as you normally would.");
    await context.newPage().then((p) => p.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }));

    const deadline = Date.now() + timeoutMs;
    let warnedCookieOnly = false;

    while (Date.now() < deadline) {
      // Prefer the network capture: only it carries a refresh token.
      if (state.captured?.refreshToken) return state.captured;

      const { token, userId, expiresInSeconds } = await readCookies(context);
      if (token) {
        const c = state.captured;
        if (c) return { ...c, userId: c.userId ?? userId, observedAuthUrls: authUrls };
        // Logged in, but no token-endpoint response seen. Give it a moment in case
        // the response is still in flight, then accept the cookie.
        if (!warnedCookieOnly) {
          warnedCookieOnly = true;
          status("Signed in. Waiting briefly for a refreshable token…");
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        return {
          accessToken: token,
          refreshToken: null,
          // Trust the cookie's own expiry; fall back to a conservative hour only
          // when it is a session cookie with no stated lifetime.
          expiresInSeconds: expiresInSeconds ?? 3600,
          userId,
          source: "cookie",
          observedAuthUrls: authUrls,
        };
      }
      if (browser.isConnected() === false) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Timed out waiting for sign-in.");
  } finally {
    // Destroy the context so no credential material outlives this call.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
