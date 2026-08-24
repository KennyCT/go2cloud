/**
 * GoPro Cloud error taxonomy.
 *
 * Established by live probing (PLAN.md §2.4). GoPro publishes no documentation,
 * and several of these codes mean something other than the obvious.
 */

export type GoProErrorKind =
  /** Vendor Accept header missing or unrecognised. A bug in our client, never transient. */
  | "bad-accept"
  /**
   * Vendor mediatype version rejected. This is the API-deprecation canary:
   * GoPro retiring version=2.0.0 surfaces here first. Alert loudly.
   */
  | "version-gone"
  /** Credentials rejected — refresh, then re-authenticate. */
  | "unauthorized"
  /** Rate limited. No Retry-After is guaranteed; always keep an exponential fallback. */
  | "rate-limited"
  /**
   * Server error. On an *authenticated* call this may also mean a dead token, so
   * attempt one refresh before classifying it as transient (PLAN.md §2.4).
   * Also observed for a malformed range parameter, which is NOT transient.
   */
  | "server"
  /** Signed CDN URL expired (1 h TTL) — re-resolve the manifest and resume. */
  | "url-expired"
  | "not-found"
  | "network"
  | "unknown";

export class GoProError extends Error {
  readonly kind: GoProErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(kind: GoProErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GoProError";
    this.kind = kind;
    this.status = status;
    this.retryable = kind === "rate-limited" || kind === "server" || kind === "network";
  }
}

export function classify(status: number, body?: string): GoProError {
  switch (status) {
    case 401:
      return new GoProError(
        "unauthorized",
        "GoPro session expired or rejected. Run `go2cloud auth gopro` to sign in again.",
        status,
      );
    case 403:
      return new GoProError("url-expired", "Signed URL expired or forbidden", status);
    case 404:
      return new GoProError("not-found", "Resource not found", status);
    case 406:
      return new GoProError(
        "bad-accept",
        "Missing or unrecognised vendor Accept header — this is a client bug",
        status,
      );
    case 410:
      return new GoProError(
        "version-gone",
        "GoPro retired this API version. go2cloud needs updating — please file an issue.",
        status,
      );
    case 415:
      return new GoProError("bad-accept", "Unsupported vendor mediatype version", status);
    case 429:
      return new GoProError("rate-limited", "Rate limited by GoPro", status);
    default:
      if (status >= 500) {
        return new GoProError("server", `GoPro server error ${status}${body ? `: ${body.slice(0, 200)}` : ""}`, status);
      }
      return new GoProError("unknown", `Unexpected status ${status}`, status);
  }
}
