/**
 * Credential storage backed by the OS keychain.
 *
 * macOS Keychain / Linux Secret Service / Windows Credential Manager, via a
 * prebuilt napi-rs addon (no node-gyp). Tokens never touch the filesystem —
 * see PLAN.md §10.
 */

import { Entry } from "@napi-rs/keyring";

const SERVICE = "go2cloud";

/** `getPassword()` returns null rather than throwing when the entry is absent. */
function entry(account: string): Entry {
  return new Entry(SERVICE, account);
}

export function readSecret(account: string): string | null {
  try {
    return entry(account).getPassword();
  } catch (err) {
    // A locked or unavailable keychain throws. Treat as "no credential" so callers
    // fall back to re-authentication rather than crashing mid-transfer.
    void err;
    return null;
  }
}

export function writeSecret(account: string, value: string): void {
  entry(account).setPassword(value);
}

export function deleteSecret(account: string): boolean {
  try {
    return entry(account).deletePassword();
  } catch {
    return false;
  }
}

/** Store a JSON credential bundle. Never log the return value of readJson. */
export function writeJson(account: string, value: unknown): void {
  writeSecret(account, JSON.stringify(value));
}

export function readJson<T>(account: string): T | null {
  const raw = readSecret(account);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt bundle is unrecoverable; drop it so the caller re-authenticates.
    deleteSecret(account);
    return null;
  }
}
