/* -------------------------------------------------------------------------
 * Playback errors, normalised once, with the engine that produced them named
 *
 * THE FILE IS STILL CALLED `shaka-error.ts` AND IT IS NO LONGER ONLY ABOUT
 * SHAKA. The name is kept because renaming it is not in PL-0904's write
 * surface, and a half-renamed module is worse than a truthfully-commented one.
 * What it is now is the single normaliser for every engine's errors, and the
 * single place either engine's numbering is written down.
 *
 * Three things here are easy to get wrong invisibly, so all three are
 * concentrated in this file rather than spread across call sites.
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
 * 3. WHOSE NUMBER IS THIS (PL-0904). Shaka reports a category and a code on
 *    shaka-player 5.2.x's scale. libmpv reports `MPV_EVENT_END_FILE` with a
 *    reason and, on `_ERROR`, an `error` value on the `mpv_error` scale. The
 *    two share the integers and share nothing else, so a `PlaybackError` names
 *    the ENGINE that produced it and keeps each engine's number inside a
 *    variant that only that engine's tag unlocks. Reading one on the other's
 *    scale is a compile error rather than a convention — see `PlaybackError`.
 *
 * A `shaka.util.Error` is NOT `instanceof Error` — Shaka says so explicitly and
 * relies on it, so every check here is structural.
 * ---------------------------------------------------------------------- */

/**
 * WHERE the error reached us. Both routes exist and both must be wired.
 *
 * THIS IS THE ROUTE AXIS AND IT IS NOT THE ENGINE AXIS — see `engine` on
 * `PlaybackError` for that one, and the note there for why the two were not
 * merged. The members below name points in the controller's own control flow,
 * not engines, and they keep exactly the meanings they had before PL-0904: a
 * regression in `shaka-error.test.ts` pins two of them and was not touched.
 */
export type PlaybackErrorOrigin =
  | "engine-load"
  | "configure"
  | "manifest-load"
  | "player-event"
  | "source-rejected";

/**
 * WHICH ENGINE produced the error, and therefore whose numbering its
 * engine-specific fields are on.
 *
 * ONE AXIS WITH `PlaybackEngineId`, TWO AXES WITH `PlaybackErrorOrigin`.
 *
 * Against `PlaybackErrorOrigin`: two axes, deliberately. Folding the engine
 * into the route union — `"native-end-file"` alongside `"manifest-load"` —
 * would make the union a sparse cross product (5 routes x 2 engines, most of
 * whose pairs cannot occur), would double every consumer's switch, and would
 * silently re-mean the five existing members as "the Shaka one". The route
 * changes when the controller's control flow changes; the engine list changes
 * when an engine is added. A union that moves for both reasons answers neither
 * question.
 *
 * Against PL-0903's `PlaybackEngineId`: ONE axis, spelled twice only because
 * PL-0903 and PL-0904 were implemented in parallel branches that could not
 * import each other. They denote the same fact and their members are identical
 * on purpose. THE MERGE IS ONE-DIRECTIONAL: `PlaybackEngineId` should become
 * `export type PlaybackEngineId = PlaybackErrorEngine`, not the reverse,
 * because this module imports nothing and `playback-controller.ts` already
 * imports it — aliasing the other way would pull the Shaka-injection port in
 * `engine.ts` into the error vocabulary's import graph, which is the
 * dependency direction `docs/DESKTOP_PLAYBACK.md` §3 exists to forbid. Nothing
 * mechanical asserts the two agree yet, because the other declaration does not
 * exist on this branch; the assertion belongs to whichever task lands second.
 */
export type PlaybackErrorEngine = "web-shaka" | "native-mpv";

export type PlaybackErrorSeverity = "critical" | "recoverable" | "unknown";

/**
 * Transport-level detail, and ENGINE-NEUTRAL BY CONSTRUCTION.
 *
 * Every variant names a number space that belongs to neither engine: HTTP's
 * statuses, and the HTML standard's `MediaError.code`. That is why `detail`
 * sits beside the engine variant rather than inside it — an HTTP 404 is a 404
 * whoever made the request, and a classifier may read it without first asking
 * which engine spoke. The engine's OWN number never lands here; it lands in
 * `PlaybackEngineFault`.
 */
export type PlaybackErrorDetail =
  | { readonly kind: "http-status"; readonly url: string | null; readonly status: number | null; readonly finalUrl: string | null }
  | { readonly kind: "network"; readonly url: string | null }
  | { readonly kind: "timeout"; readonly url: string | null }
  | { readonly kind: "media-element"; readonly mediaErrorCode: number | null };

/**
 * Shaka's own numbering, pinned to shaka-player 5.2.x.
 *
 * `category` and `code` are `shaka.util.Error.Category` and
 * `shaka.util.Error.Code`. Both are meaningless on any other engine's scale.
 */
export interface ShakaFault {
  readonly code: number;
  readonly category: number;
  readonly categoryName: string | null;
}

/**
 * `MPV_EVENT_END_FILE`'s reason, in our spelling rather than libmpv's.
 *
 * These are OUR five string literals, not an mpv type: nothing in this file's
 * import graph reaches libmpv, which is the rule `docs/DESKTOP_PLAYBACK.md` §3
 * states for the adapter boundary and which this vocabulary has to respect for
 * the same reason.
 */
export type NativeEndFileReason = "eof" | "stop" | "quit" | "error" | "redirect";

/**
 * The subset of END_FILE reasons that reaches the machine as an `ENGINE_ERROR`.
 *
 * `docs/DESKTOP_PLAYBACK.md` §6 routes the other two elsewhere: `_EOF` is
 * `MEDIA_ENDED` and `_QUIT` is `ENGINE_STATE { status: "destroyed" }`. Encoding
 * that as a type rather than as a comment means building a playback error out
 * of a clean end-of-file does not compile. `Extract` rather than a second
 * literal union, so the subset relation is checked instead of asserted.
 */
export type NativeFailureReason = Extract<NativeEndFileReason, "error" | "stop" | "redirect">;

/**
 * libmpv's own diagnostic, on libmpv's own scale.
 *
 * `mpvError` is the `error` field `MPV_EVENT_END_FILE` carries on `_ERROR`, a
 * value of the `mpv_error` enum. IT IS NOT A SHAKA CODE AND IT IS NOT AN HTTP
 * STATUS, and the only reason it can be carried at all is that reaching it
 * requires narrowing `PlaybackError` to the native variant first.
 *
 * THERE IS NO `mpvErrorName`, and the absence is a record rather than an
 * oversight. `ShakaFault` can name its category because `CATEGORY_NAMES` below
 * was read off shaka-player 5.2.6. `docs/DESKTOP_PLAYBACK.md` §5 states that
 * the `mpv_error` enum was NOT verified by PL-0901's research, so a name table
 * here would be invented. It lands with the adapter, against `client.h`.
 */
export interface NativeFault {
  readonly reason: NativeFailureReason;
  readonly mpvError: number | null;
}

/**
 * Whichever engine's number this error carries, if it carries one at all.
 *
 * Exported as the vocabulary rather than consumed here: a reader that wants to
 * hold "some engine's fault" — an adapter, a trail writer, PL-0503's telemetry
 * — names this and is then forced to discriminate before reading a number. No
 * member of it is readable without that discrimination, which is the property
 * the whole design is for.
 */
export type PlaybackEngineFault = ShakaFault | NativeFault;

interface PlaybackErrorCommon {
  readonly origin: PlaybackErrorOrigin;
  readonly severity: PlaybackErrorSeverity;
  /**
   * Whether the session is over. Not a synonym for `severity === "critical"`:
   * see `aborted` below.
   */
  readonly fatal: boolean;
  /**
   * True when WE ended the operation rather than the stream failing.
   *
   * On Shaka that is the two codes it raises for our own control flow —
   * LOAD_INTERRUPTED (a second `load()`) and OPERATION_ABORTED. They arrive
   * with CRITICAL severity but describe our own control flow, and reporting
   * them as playback failures makes every candidate failover look like a fault.
   * On mpv it is END_FILE `_STOP` and `_REDIRECT`, for exactly the same reason
   * and with exactly the same consequence.
   */
  readonly aborted: boolean;
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

/**
 * An error from the Shaka/EME engine.
 *
 * `code`, `category` and `categoryName` are PINNED TO SHAKA 5.2.x and are a
 * flattened projection of `fault` — they are kept because
 * `summarisePlaybackError` in `playback-machine.ts` reads them by name and that
 * file is not PL-0904's to write. Read `fault` in new code; the flat trio is
 * the compatibility surface and should be retired into it by whichever task
 * next owns the machine.
 */
export interface WebShakaPlaybackError extends PlaybackErrorCommon {
  readonly engine: "web-shaka";
  readonly code: number | null;
  readonly category: number | null;
  readonly categoryName: string | null;
  readonly fault: ShakaFault | null;
}

/**
 * An error from the libmpv engine.
 *
 * `code`, `category` and `categoryName` ARE TYPED `null`, NOT `number | null`,
 * AND THAT IS THE POINT OF THIS TASK. PL-0903 asked for exactly this: an mpv
 * number assigned to `code` would be read by `classifyPlaybackFailure` — and by
 * every reason trail, dashboard and bug report downstream — as a Shaka 5.2.x
 * code meaning something else entirely. The `null` literal types make that
 * assignment a compile error rather than a convention someone honours until a
 * hurried afternoon. mpv's diagnostic is not discarded; it is in `fault`, where
 * reaching it costs a narrow on `engine` first.
 */
export interface NativeMpvPlaybackError extends PlaybackErrorCommon {
  readonly engine: "native-mpv";
  readonly code: null;
  readonly category: null;
  readonly categoryName: null;
  readonly fault: NativeFault | null;
}

/**
 * One playback error, tagged with the engine that produced it.
 *
 * A DISCRIMINATED UNION rather than an interface with an `engine` string beside
 * loose numeric fields, because the whole requirement is that an engine's code
 * is interpretable only in that engine's terms. A tag alone leaves
 * `error.code` readable without ever consulting it; a union makes the narrow
 * mandatory and makes the wrong read fail the build.
 */
export type PlaybackError = WebShakaPlaybackError | NativeMpvPlaybackError;

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
 * Normalise anything thrown, rejected or dispatched at us on the WEB path into
 * one shape.
 *
 * Values that are not Shaka errors get `severity: "unknown"`, `fatal: true` and
 * `fault: null`. Treating an unclassifiable failure as recoverable is the worse
 * mistake: it leaves the caller retrying against a session that will never
 * work, with no state that says so.
 *
 * The engine is `"web-shaka"` on every path through this function, including
 * the non-Shaka one. That is a claim about WHO PRODUCED THE ERROR, not about
 * whose numbers it carries: a `TypeError` from the dynamic import and a
 * source rejection both came out of the web pipeline, and both say so while
 * carrying `fault: null` to mean "no engine-numbered code at all". The native
 * engine has its own constructor below and never reaches this one.
 */
export function describePlaybackError(
  raw: unknown,
  origin: PlaybackErrorOrigin
): WebShakaPlaybackError {
  if (!isShakaErrorLike(raw)) {
    return {
      origin,
      engine: "web-shaka",
      severity: "unknown",
      fatal: true,
      aborted: false,
      code: null,
      category: null,
      categoryName: null,
      fault: null,
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

  /* The fault is the authority and the flat trio is its projection, written
   * from the same three values so the two cannot disagree. */
  const fault: ShakaFault = {
    code: raw.code,
    category: raw.category,
    categoryName: CATEGORY_NAMES[raw.category] ?? null
  };

  return {
    origin,
    engine: "web-shaka",
    severity,
    fatal: severity !== "recoverable" && !aborted,
    aborted,
    code: fault.code,
    category: fault.category,
    categoryName: fault.categoryName,
    fault,
    message: readMessage(raw, `Shaka error ${raw.code}`),
    detail: decodeShakaErrorData(raw.code, raw.data),
    raw
  };
}

/**
 * What the native adapter hands us out of `MPV_EVENT_END_FILE`.
 *
 * `reason` cannot be `_EOF` or `_QUIT` — see `NativeFailureReason`. `mpvError`
 * is libmpv's `error` field and is carried verbatim, unread. `detail` is the
 * engine-neutral slot and is the ONLY place a classifier is allowed to find
 * something it can act on; if the adapter ever learns an HTTP status it belongs
 * there, never in `mpvError`.
 *
 * A URL in `message` is the caller's redaction duty, exactly as it already is
 * for the Shaka path — `redactMediaUrl` is exported for it.
 */
export interface NativeEndFileReport {
  readonly reason: NativeFailureReason;
  readonly mpvError?: number | null;
  readonly message?: string;
  readonly detail?: PlaybackErrorDetail | null;
  readonly raw?: unknown;
}

/**
 * mpv's END_FILE, normalised into the same shape without borrowing a number.
 *
 * SEVERITY IS ALWAYS `"unknown"`, and that is honest rather than lazy: mpv has
 * no severity concept at all, so reporting `"critical"` would be reporting a
 * field libmpv never filled in. `fatal` is then the SAME RULE the Shaka path
 * uses, `severity !== "recoverable" && !aborted`, which reduces to `!aborted`
 * here because the left conjunct is always true — and it lands
 * where `docs/DESKTOP_PLAYBACK.md` §6 says it must: `_ERROR` is fatal and
 * reaches `recordCandidateFailure`, `_STOP` and `_REDIRECT` are aborted and are
 * dropped by `errorIsAborted` exactly as Shaka's LOAD_INTERRUPTED is, because
 * our own control flow is not a candidate failure.
 *
 * NOTHING HERE CLASSIFIES. The mpv error value is recorded and not interpreted;
 * `playback-failure.ts` decides, per engine, and for mpv it decides `null`.
 */
export function describeNativePlaybackError(
  report: NativeEndFileReport,
  origin: PlaybackErrorOrigin
): NativeMpvPlaybackError {
  const aborted = report.reason === "stop" || report.reason === "redirect";
  const mpvError = finiteOrNull(report.mpvError);
  const fault: NativeFault = { reason: report.reason, mpvError };

  return {
    origin,
    engine: "native-mpv",
    severity: "unknown",
    fatal: !aborted,
    aborted,
    code: null,
    category: null,
    categoryName: null,
    fault,
    message:
      typeof report.message === "string" && report.message !== ""
        ? report.message
        : describeEndFile(report.reason, mpvError),
    detail: report.detail ?? null,
    raw: report.raw ?? null
  };
}

function describeEndFile(reason: NativeFailureReason, mpvError: number | null): string {
  if (reason !== "error") return `mpv playback ended (END_FILE ${reason})`;
  return mpvError === null
    ? "mpv playback ended with an error (END_FILE error)"
    : `mpv playback ended with an error (END_FILE error, mpv_error ${mpvError})`;
}
