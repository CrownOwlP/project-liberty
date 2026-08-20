/* -------------------------------------------------------------------------
 * Shaka errors, normalised once
 *
 * Two things here are easy to get wrong invisibly, so both are concentrated in
 * this file rather than spread across call sites.
 *
 * 1. THE SEVERITY SPLIT. `shaka.util.Error.severity` is `RECOVERABLE` (1) or
 *    `CRITICAL` (2), and that distinction is the fatal/non-fatal decision
 *    handed to us — Shaka retries a failed segment forever without ever raising
 *    a CRITICAL. Collapsing the two into "an error happened" produces a player
 *    that gives up on a blip, or one that sits on a dead session forever.
 *
 * 2. THE POSITIONAL `data` ARRAY. Shaka's own documentation says "each type of
 *    error has its own data structure (or none at all)": `data[1]` is an HTTP
 *    status for BAD_HTTP_STATUS and the original exception for HTTP_ERROR. Any
 *    indexing into it is PINNED TO THE SHAKA MINOR and lives in
 *    `decodeShakaErrorData` below, so an upgrade breaks one function with one
 *    test rather than five call sites silently reading the wrong slot.
 *    Verified against shaka-player 5.2.6 `lib/util/error.js`.
 *
 * A `shaka.util.Error` is NOT `instanceof Error` — Shaka says so explicitly and
 * relies on it, so every check here is structural.
 * ---------------------------------------------------------------------- */

/** Where the error reached us. Both routes exist and both must be wired. */
export type PlaybackErrorOrigin =
  | "engine-load"
  | "configure"
  | "manifest-load"
  | "player-event"
  | "source-rejected";

export type PlaybackErrorSeverity = "critical" | "recoverable" | "unknown";

export type PlaybackErrorDetail =
  | { readonly kind: "http-status"; readonly url: string | null; readonly status: number | null; readonly finalUrl: string | null }
  | { readonly kind: "network"; readonly url: string | null }
  | { readonly kind: "timeout"; readonly url: string | null }
  | { readonly kind: "media-element"; readonly mediaErrorCode: number | null };

export interface PlaybackError {
  readonly origin: PlaybackErrorOrigin;
  readonly severity: PlaybackErrorSeverity;
  /**
   * Whether the session is over. Not a synonym for `severity === "critical"`:
   * see `aborted` below.
   */
  readonly fatal: boolean;
  /**
   * True for the two codes Shaka raises when WE ended an operation —
   * LOAD_INTERRUPTED (a second `load()`) and OPERATION_ABORTED. They arrive
   * with CRITICAL severity but describe our own control flow, and reporting
   * them as playback failures makes every candidate failover look like a fault.
   */
  readonly aborted: boolean;
  readonly code: number | null;
  readonly category: number | null;
  readonly categoryName: string | null;
  readonly message: string;
  readonly detail: PlaybackErrorDetail | null;
  /**
   * The original value, for a debugger. PL-0503 must NOT put this on the wire:
   * it can hold manifest URLs with signed query strings, which is the leak
   * `docs/RESEARCH_PLAYBACK.md` flags for the CMCD `url`/`nor` keys through a
   * different pipe. Use `detail`, whose URLs are already stripped.
   */
  readonly raw: unknown;
}

/* Pinned to shaka-player 5.2.x, `shaka.util.Error.Severity`. */
const SEVERITY_RECOVERABLE = 1;
const SEVERITY_CRITICAL = 2;

/* Pinned to shaka-player 5.2.x, `shaka.util.Error.Category`. */
const CATEGORY_NAMES: Readonly<Record<number, string>> = {
  1: "NETWORK",
  2: "TEXT",
  3: "MEDIA",
  4: "MANIFEST",
  5: "STREAMING",
  6: "DRM",
  7: "PLAYER",
  8: "CAST",
  9: "STORAGE",
  10: "ADS"
};

/* Pinned to shaka-player 5.2.x, `shaka.util.Error.Code`. */
const CODE_BAD_HTTP_STATUS = 1001;
const CODE_HTTP_ERROR = 1002;
const CODE_TIMEOUT = 1003;
const CODE_VIDEO_ERROR = 3016;
const CODE_LOAD_INTERRUPTED = 7000;
const CODE_OPERATION_ABORTED = 7001;

interface ShakaErrorLike {
  readonly severity: number;
  readonly category: number;
  readonly code: number;
  readonly data?: unknown;
  readonly message?: unknown;
}

function isShakaErrorLike(value: unknown): value is ShakaErrorLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.severity === "number" &&
    typeof candidate.category === "number" &&
    typeof candidate.code === "number"
  );
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Origin and path only.
 *
 * Media URLs routinely carry a signed query string, and an error object is the
 * one place a credential travels without anyone deciding to log it. The host
 * and path are what identify a failing CDN edge; the signature never is.
 */
export function redactMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    /* Not a URL. Echoing an unparsable string would echo whatever it was. */
    return null;
  }
}

/**
 * The ONLY place Shaka's positional error data is indexed.
 *
 * PINNED TO SHAKA 5.2.x. Adding a code here means reading its `data[]`
 * contract in `lib/util/error.js` for that exact version. An unrecognised code
 * returns `null` rather than a guess, because a wrong guess about slot 1 is
 * indistinguishable from a real value at every consumer.
 */
export function decodeShakaErrorData(code: number, data: unknown): PlaybackErrorDetail | null {
  if (!Array.isArray(data)) return null;
  const slots = data as readonly unknown[];

  switch (code) {
    case CODE_BAD_HTTP_STATUS:
      return {
        kind: "http-status",
        url: redactMediaUrl(slots[0]),
        status: finiteOrNull(slots[1]),
        // Present when the request was redirected; the difference between this
        // and `url` is how a CDN failover shows up in a reason trail.
        finalUrl: redactMediaUrl(slots[5])
      };
    case CODE_HTTP_ERROR:
      // slots[1] is the underlying exception and is deliberately not decoded:
      // its shape is the browser's, not Shaka's, and it varies per engine.
      return { kind: "network", url: redactMediaUrl(slots[0]) };
    case CODE_TIMEOUT:
      return { kind: "timeout", url: redactMediaUrl(slots[0]) };
    case CODE_VIDEO_ERROR:
      // slots[0] is a `MediaError.code` from the video element, not a Shaka
      // code. They share a number space and mean different things.
      return { kind: "media-element", mediaErrorCode: finiteOrNull(slots[0]) };
    default:
      return null;
  }
}

function readMessage(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message !== "") return message;
  }
  if (typeof value === "string" && value !== "") return value;
  return fallback;
}

/**
 * Normalise anything thrown, rejected or dispatched at us into one shape.
 *
 * Values that are not Shaka errors get `severity: "unknown"` and `fatal: true`.
 * Treating an unclassifiable failure as recoverable is the worse mistake: it
 * leaves the caller retrying against a session that will never work, with no
 * state that says so.
 */
export function describePlaybackError(raw: unknown, origin: PlaybackErrorOrigin): PlaybackError {
  if (!isShakaErrorLike(raw)) {
    return {
      origin,
      severity: "unknown",
      fatal: true,
      aborted: false,
      code: null,
      category: null,
      categoryName: null,
      message: readMessage(raw, "Unclassified playback error."),
      detail: null,
      raw
    };
  }

  const severity: PlaybackErrorSeverity =
    raw.severity === SEVERITY_CRITICAL
      ? "critical"
      : raw.severity === SEVERITY_RECOVERABLE
        ? "recoverable"
        : "unknown";

  const aborted = raw.code === CODE_LOAD_INTERRUPTED || raw.code === CODE_OPERATION_ABORTED;

  return {
    origin,
    severity,
    fatal: severity !== "recoverable" && !aborted,
    aborted,
    code: raw.code,
    category: raw.category,
    categoryName: CATEGORY_NAMES[raw.category] ?? null,
    message: readMessage(raw, `Shaka error ${raw.code}`),
    detail: decodeShakaErrorData(raw.code, raw.data),
    raw
  };
}
