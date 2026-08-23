/**
 * Google OAuth — loopback + PKCE against the user's own Desktop client.
 *
 * Each user brings their own Google Cloud project (PLAN.md §5.2), so no shared
 * credential ever brokers anyone's data. Publish the app to Production or Google
 * expires refresh tokens after 7 days; the wizard in docs/SETUP-GOOGLE.md covers it.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readJson, writeJson, deleteSecret } from "../util/keychain.js";

const ACCOUNT = "google";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Hardcoded — never generated from the discovery doc, which still lists removed scopes. */
export const SCOPES = [
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
];

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  obtainedAt: number;
}

/** Read a client_secret_*.json downloaded from the Cloud Console. */
export function loadClientConfig(path: string): GoogleClientConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const node = (parsed["installed"] ?? parsed["web"] ?? parsed) as Record<string, unknown>;
  const clientId = node["client_id"];
  const clientSecret = node["client_secret"];
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error(`${path} is not an OAuth client JSON (no client_id/client_secret).`);
  }
  if (parsed["web"] && !parsed["installed"]) {
    throw new Error("This is a Web application client. go2cloud needs a Desktop app client.");
  }
  return { clientId, clientSecret };
}

const b64url = (b: Buffer) => b.toString("base64url");

function saveConfig(cfg: GoogleClientConfig): void {
  writeJson(`${ACCOUNT}-client`, cfg);
}
export function loadConfig(): GoogleClientConfig | null {
  return readJson<GoogleClientConfig>(`${ACCOUNT}-client`);
}
export function loadTokens(): GoogleTokens | null {
  return readJson<GoogleTokens>(ACCOUNT);
}
export function clearGoogle(): void {
  deleteSecret(ACCOUNT);
  deleteSecret(`${ACCOUNT}-client`);
}

function store(body: Record<string, unknown>, fallbackRefresh: string | null): GoogleTokens {
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
  const t: GoogleTokens = {
    accessToken: String(body["access_token"] ?? ""),
    refreshToken: typeof body["refresh_token"] === "string" ? body["refresh_token"] : fallbackRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
    obtainedAt: Date.now(),
  };
  writeJson(ACCOUNT, t);
  return t;
}

/** Run the consent flow. Returns once the browser has redirected back to loopback. */
export async function authorize(
  cfg: GoogleClientConfig,
  openBrowser: (url: string) => void,
): Promise<GoogleTokens> {
  saveConfig(cfg);
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      const got = url.searchParams;
      const ok = got.get("code") && got.get("state") === state;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>go2cloud: ${ok ? "authorised — you can close this tab." : "authorisation failed"}</h2>`);
      server.close();
      if (ok) {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ code: got.get("code") as string, redirectUri: `http://127.0.0.1:${port}/` });
      } else {
        reject(new Error(`Authorisation failed: ${got.get("error") ?? "state mismatch"}`));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirect = `http://127.0.0.1:${port}/`;
      const u = new URL(AUTH_URL);
      u.search = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      openBrowser(u.toString());
    });
    setTimeout(() => { server.close(); reject(new Error("Timed out waiting for consent.")); }, 300_000);
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
      code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(body)}`);
  return store(body, null);
}

export class GoogleAuthError extends Error {}

export async function accessToken(): Promise<string> {
  const cfg = loadConfig();
  const t = loadTokens();
  if (!cfg || !t) throw new GoogleAuthError("Not signed in to Google. Run `go2cloud auth google --setup`.");
  if (Date.now() < t.expiresAt - 120_000) return t.accessToken;
  if (!t.refreshToken) throw new GoogleAuthError("No refresh token — re-run `go2cloud auth google`.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      refresh_token: t.refreshToken, grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = String(body["error"] ?? res.status);
    // invalid_grant after ~7 days means the app was left in Testing publishing status.
    const hint = err === "invalid_grant"
      ? " Your OAuth app is probably still in Testing — set Publishing status to In production (docs/SETUP-GOOGLE.md)."
      : err === "deleted_client"
        ? " The OAuth client was auto-deleted after 6 months idle; it is restorable for 30 days in the Cloud Console."
        : "";
    throw new GoogleAuthError(`Google refused the refresh grant (${err}).${hint}`);
  }
  return store(body, t.refreshToken).accessToken;
}
