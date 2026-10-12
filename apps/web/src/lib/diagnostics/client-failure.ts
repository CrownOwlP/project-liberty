/* -------------------------------------------------------------------------
 * What the browser says when a render boundary catches something (PL-0759).
 *
 * THE DEFECT THIS EXISTS FOR, AND IT IS A DEFECT IN A COMMENT AS MUCH AS IN
 * CODE. The installed Windows application showed `global-error.tsx`:
 *
 *     Project Liberty could not start this page
 *     Something failed before the application frame could render. Reloading
 *     usually clears it. If it does not, THE APPLICATION LOG HAS THE DETAIL.
 *
 * The log did not have the detail. `global-error.tsx` took only `reset` -- it
 * never received Next's `error` argument -- logged nothing, and showed no
 * digest, with a comment explaining that the log had it. So the one screen the
 * operator was looking at was the only screen in this application that cannot
 * say what went wrong, and three rounds of Windows work were spent guessing at
 * a failure that was reporting itself to nobody.
 *
 * WHAT THIS MODULE IS. A description of a caught render failure, sanitised, and
 * a fire-and-forget way to send it to the local server -- whose stdout and
 * stderr the Rust shell already captures, redacts and writes to
 * `%LOCALAPPDATA%\app.projectliberty.desktop\logs\sidecar.log`. No new log
 * file, no new transport, no new place for an operator to look: the one place
 * they already paste from gains the thing it was missing.
 *
 * IT IMPORTS NOTHING, and that is a requirement rather than a coincidence.
 * `global-error.tsx` replaces the whole document and must not import the shell,
 * the stylesheet, or anything else that could be what just failed. This module
 * pulls in no React, no CSS, no contract package and no other application
 * module; it uses `fetch` and string operations. A reporter that could itself
 * throw inside the last-resort boundary would turn a diagnosable failure into a
 * blank page, which is the state that boundary was built to remove.
 *
 * WHAT IS DELIBERATELY NOT SENT. The error MESSAGE and the STACK. A message
 * from a server component can carry a file path, a connection string, a query
 * or a token; a stack carries build paths and, in a dev build, source. The
 * boundary's existing comment is right that a digest is the only thing safe to
 * surface, and the correction is to actually surface it rather than to omit it
 * and claim the log has it. `errorName` is sent because a constructor name is
 * a closed vocabulary in practice and is checked against a strict pattern
 * before it leaves; `hadMessage` is sent as a BOOLEAN so a reader can tell an
 * error that said nothing from one whose text was withheld here.
 *
 * WAVE 132: WHAT THE 131A REPORT COULD NOT ANSWER, AND WHY TWO FIELDS WERE
 * ADDED. The operator's installed MSI produced exactly this line:
 *
 *     liberty-client-failure {"boundary":"global-error","pathname":"/",
 *       "digest":null,"errorName":"TypeError","hadMessage":true}
 *
 * That is a real improvement over silence and it is still not a cause. It says
 * a TypeError was thrown on the client, with a message that was withheld, in a
 * boundary at or above the root layout. Four candidate explanations were ranked
 * from a source audit and ALL FOUR WERE REFUTED by measurement: the packaged
 * artifact was booted and driven in Chromium with `Intl.Segmenter` removed,
 * with `Intl.Segmenter` throwing on construction, with `Object.hasOwn` removed
 * and with `structuredClone` removed, and in every one of those four runs the
 * homepage still rendered the application. Guessing has now cost four rounds.
 *
 * SO THE REPORT MUST NAME THE THROWING EXPRESSION, and these two fields are the
 * narrowest pair that can:
 *
 *   `shape`  -- a CLASSIFICATION of the message against a closed set of
 *     anchored patterns, never the message. "Cannot read properties of
 *     undefined" and "x is not a function" are different defects with
 *     different fixes, and `hadMessage: true` cannot tell them apart.
 *
 *   `frames` -- `{ chunk, line, column }` for the first few stack frames, and
 *     ONLY for frames whose URL is under `/_next/static/`. The header above
 *     says a stack is withheld because "a stack carries build paths", and that
 *     reason is exactly right about a stack; it is not true of these frames,
 *     and the distinction is the whole justification for the change. What is
 *     kept is the LAST PATH SEGMENT of a public asset URL -- a chunk basename
 *     that is already printed in the page's own script tags -- plus two
 *     integers. What is dropped is the scheme, the host, the port, the
 *     directory, the function name, and every frame that is not one of our
 *     served assets (so a `file://` path, an extension URL, an inline-script
 *     position and a node internal cannot travel). A basename and a line:column
 *     is enough to resolve the expression against the identical chunk in the
 *     build that produced it, which is what ends the guessing.
 * ---------------------------------------------------------------------- */

/** Where a report is posted. One path, named once, so the route and the client agree. */
export const CLIENT_FAILURE_PATH = "/api/v1/diagnostics/client-failure";

/**
 * Which boundary caught it. A closed set, because the value is written into a
 * log line an operator reads and a free-form string would let any future caller
 * invent a vocabulary nobody has to explain.
 */
export const FAILURE_BOUNDARIES = ["global-error", "route-error"] as const;
export type FailureBoundary = (typeof FAILURE_BOUNDARIES)[number];

/**
 * Bounds. Every field crossing this boundary is length-capped before it is
 * logged, because the log is a file the shell budget-caps and an operator
 * pastes: one unbounded field is how a diagnostic becomes a denial of service
 * against its own log.
 */
export const MAX_DIGEST_LENGTH = 64;
export const MAX_ERROR_NAME_LENGTH = 64;
export const MAX_PATHNAME_LENGTH = 256;
export const MAX_CHUNK_NAME_LENGTH = 64;
/**
 * How many frames travel.
 *
 * The throwing frame and enough of its callers to tell which surface it was in.
 * A full stack is 20-60 frames of framework scheduling that say the same thing
 * every time, and an unbounded array is how one failure becomes a log that an
 * operator cannot paste.
 */
export const MAX_FAILURE_FRAMES = 4;
/**
 * A line or column number past which the value is not a position.
 *
 * A bundled chunk is one or two very long lines, so the COLUMN is the large
 * number here -- the real capture from the packaged build reads 31:41369. The
 * cap exists so a crafted POST cannot put an arbitrary-length integer in the
 * log, not because a real position approaches it.
 */
export const MAX_SOURCE_POSITION = 100_000_000;

/** A digest is Next's own correlation id: lowercase hex, nothing else. */
const DIGEST_PATTERN = /^[0-9a-f]+$/;
/** A constructor name. Deliberately narrower than JavaScript allows. */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_$]*$/;
/**
 * A chunk basename as Turbopack emits it, and nothing with a path in it.
 *
 * No dot other than the extension's and no separator of any kind, so a value
 * that reached this pattern cannot be a relative path, a traversal, or a
 * Windows build directory. The extension is required: a frame whose asset is
 * not a script is not a frame we can resolve.
 */
const CHUNK_NAME_PATTERN = /^[A-Za-z0-9_-]{1,59}\.(?:js|mjs)$/;

/**
 * What a message said, as a closed vocabulary.
 *
 * THE POINT IS THAT THESE ARE DIFFERENT DEFECTS. A property read off
 * `undefined` is a missing value; "is not a function" is a missing or renamed
 * export, or a method detached from its receiver; "is not a constructor" is a
 * polyfill or a feature-detection branch gone wrong; "is not defined" is a
 * free identifier the bundle expected the host to provide; an illegal
 * invocation is a host method called on the wrong receiver. `hadMessage: true`
 * is compatible with all five, which is why 131A's report could not narrow the
 * Windows failure.
 *
 * `unclassified` is a first-class answer and is NOT a failure of the
 * classifier: it means the engine said something this set does not name, which
 * is itself worth reading in a log.
 */
export const FAILURE_SHAPES = [
  "undefined_property_read",
  "not_a_function",
  "not_a_constructor",
  "not_defined",
  "illegal_invocation",
  "unclassified"
] as const;
export type FailureShape = (typeof FAILURE_SHAPES)[number];

/*
 * The patterns, ordered because a message can satisfy more than one and the
 * first match must be the most specific. Case-insensitive because the wording
 * differs between engines: Chromium says "Cannot read properties of undefined
 * (reading 'x')", Firefox says "x is undefined", and WebKit says "undefined is
 * not an object". All three are the same defect and must classify the same way.
 */
const SHAPE_PATTERNS: ReadonlyArray<readonly [FailureShape, RegExp]> = [
  ["illegal_invocation", /illegal invocation/i],
  ["not_a_constructor", /is not a constructor/i],
  ["not_a_function", /is not a function|is not a method/i],
  ["not_defined", /is not defined|can't find variable/i],
  [
    "undefined_property_read",
    /cannot read propert(?:y|ies) of (?:undefined|null)|cannot read propert(?:y|ies) '[^']*' of|undefined is not an object|null is not an object|is (?:undefined|null)$/i
  ]
];

/**
 * Classify a message without recording it.
 *
 * Total against anything, because this is reached from the last-resort
 * boundary. A non-string, an empty string and a message longer than any real
 * engine message all classify as `unclassified` rather than being scanned --
 * the bound is here and not only at the caller because a regex over an
 * attacker-sized string is the denial-of-service this module exists not to be.
 */
export function classifyFailureShape(message: unknown): FailureShape {
  if (typeof message !== "string" || message.length === 0 || message.length > 2048) {
    return "unclassified";
  }
  for (const [shape, pattern] of SHAPE_PATTERNS) {
    if (pattern.test(message)) return shape;
  }
  return "unclassified";
}

/**
 * One frame, reduced to the three things that can be resolved later and cannot
 * identify anything else: a public asset's basename and a position in it.
 */
export interface ClientFailureFrame {
  readonly chunk: string;
  readonly line: number;
  readonly column: number;
}

/*
 * A stack line's asset and position.
 *
 * `/_next/static/` is required IN THE MIDDLE of the URL, so the match is
 * anchored on something only our own served assets have. Everything up to the
 * final separator is discarded, which is what keeps a build path out: a frame
 * reading `file:///D:/a/project-liberty/.next/...` does not contain
 * `/_next/static/` and never reaches the capture at all.
 */
const FRAME_PATTERN = /\/_next\/static\/(?:[^\s"'()\\]*\/)?([^\s"'()\\/]+):(\d{1,9}):(\d{1,9})/g;

/** An integer position within bounds, or `null`. */
function position(raw: string): number | null {
  if (!/^\d{1,9}$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SOURCE_POSITION) return null;
  return value;
}

/**
 * The frames worth keeping, from whatever the engine put in `stack`.
 *
 * NOT A STACK PARSER. It does not try to understand frame syntax, which differs
 * between engines and changes between versions; it scans for served-asset
 * positions anywhere in the text and keeps the first few in the order they
 * appear. An engine whose format it does not recognise yields an empty array,
 * which is the honest outcome -- the report still carries the boundary, the
 * name and the shape.
 *
 * Total: a non-string stack, a throwing getter at the call site, a stack with
 * no app frames and an enormous stack all produce an array, never a throw.
 */
export function extractFailureFrames(stack: unknown): readonly ClientFailureFrame[] {
  if (typeof stack !== "string" || stack.length === 0) return [];
  const text = stack.length > 65536 ? stack.slice(0, 65536) : stack;
  const frames: ClientFailureFrame[] = [];
  /* A fresh RegExp per call: a module-level /g literal carries lastIndex
   * between calls, which would make the second report on a page wrong. */
  const scanner = new RegExp(FRAME_PATTERN.source, "g");
  let match = scanner.exec(text);
  while (match !== null && frames.length < MAX_FAILURE_FRAMES) {
    const chunk = match[1] ?? "";
    const line = position(match[2] ?? "");
    const column = position(match[3] ?? "");
    if (
      chunk.length <= MAX_CHUNK_NAME_LENGTH &&
      CHUNK_NAME_PATTERN.test(chunk) &&
      line !== null &&
      column !== null
    ) {
      frames.push({ chunk, line, column });
    }
    match = scanner.exec(text);
  }
  return frames;
}

export interface ClientFailureReport {
  readonly boundary: FailureBoundary;
  /** Path only. Query and fragment are removed before this is built. */
  readonly pathname: string;
  readonly digest: string | null;
  readonly errorName: string | null;
  /** Whether the error carried a message, NOT the message. */
  readonly hadMessage: boolean;
  /** What the message said, as a closed vocabulary. Never the message. */
  readonly shape: FailureShape;
  /** Served-asset positions only. Never a path and never a function name. */
  readonly frames: readonly ClientFailureFrame[];
}

/**
 * A path with no query and no fragment, bounded.
 *
 * THE QUERY IS DROPPED RATHER THAN TRUNCATED. `/search?q=...` carries what the
 * viewer typed, and a diagnostic has no business recording that. `/browse`'s
 * filters are lost with it, which is a real cost and the right one: the route
 * is what identifies the failing boundary.
 */
export function sanitisePathname(raw: string): string {
  const withoutFragment = raw.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const path = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return path.slice(0, MAX_PATHNAME_LENGTH);
}

/** A value that matches `pattern` within `limit`, or `null`. Never a truncation. */
function constrained(value: unknown, pattern: RegExp, limit: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > limit) return null;
  return pattern.test(value) ? value : null;
}

/**
 * Describe a caught failure.
 *
 * Total: anything may be thrown in JavaScript, including a string, `null` or an
 * object with a throwing getter, and this is called from the last-resort
 * boundary. Every field access is guarded, and a value that does not match its
 * pattern becomes `null` rather than being coerced -- a report saying "no
 * digest" is honest, and one carrying a laundered half-digest is not.
 */
export function describeClientFailure(
  boundary: FailureBoundary,
  error: unknown,
  pathname: string
): ClientFailureReport {
  let digest: unknown;
  let name: unknown;
  let message: unknown;
  let stack: unknown;
  /*
   * FOUR SEPARATE READS, NOT ONE DESTRUCTURING. A throwing getter on `digest`
   * must not cost us `name`, `message` and `stack` as well -- and with a single
   * try around all four it would, because the first throw skips the rest. The
   * Windows failure is reported by this function and by nothing else, so a
   * report that loses three fields to one hostile property is a report that
   * cannot do its job.
   */
  const bag = error as Record<string, unknown> | null | undefined;
  try { digest = bag?.digest; } catch { /* kept null */ }
  try { name = bag?.name; } catch { /* kept null */ }
  try { message = bag?.message; } catch { /* kept false */ }
  try { stack = bag?.stack; } catch { /* kept empty */ }
  let frames: readonly ClientFailureFrame[] = [];
  try { frames = extractFailureFrames(stack); } catch { frames = []; }
  let shape: FailureShape = "unclassified";
  try { shape = classifyFailureShape(message); } catch { shape = "unclassified"; }
  return {
    boundary,
    pathname: sanitisePathname(pathname),
    digest: constrained(digest, DIGEST_PATTERN, MAX_DIGEST_LENGTH),
    errorName: constrained(name, ERROR_NAME_PATTERN, MAX_ERROR_NAME_LENGTH),
    hadMessage: typeof message === "string" && message.length > 0,
    shape,
    frames
  };
}

/**
 * Re-validate a report that arrived over the wire.
 *
 * THE SERVER DOES NOT TRUST THE CLIENT THAT SHARES ITS ORIGIN. The body reaches
 * a line in a log file an operator pastes into a conversation, so it is
 * re-sanitised with the same rules that produced it rather than being believed
 * because it came from our own page. Returns `null` for anything that is not a
 * report, which the route answers with a refusal.
 */
export function readClientFailure(body: unknown): ClientFailureReport | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const bag = body as Record<string, unknown>;
  const boundary = FAILURE_BOUNDARIES.find((candidate) => candidate === bag.boundary);
  if (boundary === undefined) return null;
  if (typeof bag.pathname !== "string" || bag.pathname.length === 0) return null;
  return {
    boundary,
    pathname: sanitisePathname(bag.pathname),
    digest: constrained(bag.digest, DIGEST_PATTERN, MAX_DIGEST_LENGTH),
    errorName: constrained(bag.errorName, ERROR_NAME_PATTERN, MAX_ERROR_NAME_LENGTH),
    hadMessage: bag.hadMessage === true,
    /*
     * THE SHAPE IS CHECKED AGAINST THE SET, NOT ACCEPTED AS A STRING. An
     * unrecognised value becomes `unclassified` rather than reaching the log,
     * so this field cannot be used to write chosen text into the file the
     * operator pastes.
     */
    shape: FAILURE_SHAPES.find((candidate) => candidate === bag.shape) ?? "unclassified",
    /*
     * AND THE FRAMES ARE REBUILT, not filtered. Each one is reconstructed from
     * three validated primitives, so no extra property on a submitted frame
     * object can survive, and a frame whose chunk is not a bare basename or
     * whose position is not an in-bounds integer is dropped entirely.
     */
    frames: readFrames(bag.frames)
  };
}

/**
 * Validate frames that arrived over the wire.
 *
 * Separate from `extractFailureFrames` on purpose: that one reads an engine's
 * stack text, this one reads a JSON array from a request body. Sharing one
 * function would mean the server trusted the client's parse.
 */
function readFrames(raw: unknown): readonly ClientFailureFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames: ClientFailureFrame[] = [];
  for (const entry of raw.slice(0, MAX_FAILURE_FRAMES)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const chunk = candidate.chunk;
    const line = candidate.line;
    const column = candidate.column;
    if (typeof chunk !== "string" || chunk.length > MAX_CHUNK_NAME_LENGTH) continue;
    if (!CHUNK_NAME_PATTERN.test(chunk)) continue;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) continue;
    const lineNumber = line as number;
    const columnNumber = column as number;
    if (lineNumber < 0 || lineNumber > MAX_SOURCE_POSITION) continue;
    if (columnNumber < 0 || columnNumber > MAX_SOURCE_POSITION) continue;
    frames.push({ chunk, line: lineNumber, column: columnNumber });
  }
  return frames;
}

/**
 * The one line that reaches the log.
 *
 * A PREFIX AND ONE JSON OBJECT, because the consumer is `sidecar_log.rs` and an
 * operator's eye. The prefix is greppable and the payload is a single line, so
 * a failure that repeats does not become a wall. Built from the re-validated
 * report, never from the request body.
 */
export const CLIENT_FAILURE_LOG_PREFIX = "liberty-client-failure";

export function formatClientFailureLine(report: ClientFailureReport): string {
  return `${CLIENT_FAILURE_LOG_PREFIX} ${JSON.stringify(report)}`;
}

/**
 * The same facts, as one line a person can read off a screen and type back.
 *
 * WHY THE SCREEN NEEDS THIS AND NOT ONLY THE LOG. The POST can legitimately
 * fail: on a deployment with no sidecar token the request guard answers it 403,
 * and a CSP or a dead route would do the same. In those cases the boundary is
 * the ONLY channel, and "no reference was issued" was all it could say. This is
 * built from the identical report the log line is built from, so the two cannot
 * drift -- the screen and the file say the same thing or neither does.
 *
 * It carries no message, no path and no function name, because the report does
 * not carry them. A digest appears when Next minted one; a client-side throw
 * has none, and the shape and the throwing frame are what stand in its place.
 */
export function formatClientFailureReference(report: ClientFailureReport): string {
  const parts: string[] = [report.boundary];
  if (report.errorName !== null) parts.push(report.errorName);
  if (report.shape !== "unclassified") parts.push(report.shape);
  const frame = report.frames[0];
  if (frame !== undefined) parts.push(`${frame.chunk}:${String(frame.line)}:${String(frame.column)}`);
  if (report.digest !== null) parts.push(`digest ${report.digest}`);
  return parts.join(" \u00b7 ");
}

/**
 * Send a report, and never let sending it become the failure.
 *
 * `void`, not a promise: the caller is a render boundary and must not await
 * anything. `keepalive` so a report survives the navigation a "Try again"
 * causes. Every failure path is swallowed -- on a deployment there is no
 * sidecar token, so this POST is answered 403 by the request guard and that is
 * the correct outcome rather than an error to surface.
 */
export const REPORTER_BUDGET = 4;

/*
 * The reporter's own budget state. Module-scoped, so it is per document, which
 * is the right scope: a reload is a new page and genuinely a new failure.
 */
let reportsSent = 0;
const reportsSeen: string[] = [];

/** Reset the reporter's budget. Tests only; nothing in the application calls it. */
export function resetClientFailureReporter(): void {
  reportsSent = 0;
  reportsSeen.length = 0;
}

/**
 * How many POSTs this document has issued. Tests only.
 */
export function clientFailureReportsSent(): number {
  return reportsSent;
}

export function reportClientFailure(report: ClientFailureReport): void {
  /*
   * MEASURED, NOT ANTICIPATED: 52 POSTS FOR ONE FAILURE.
   *
   * The packaged artifact was driven in Chromium with a throw injected into a
   * component inside the application shell, and the page issued FIFTY-TWO
   * requests to this route for that single defect. React retries a boundary,
   * each retry re-runs the reporting effect, and the server's budget -- which
   * does exist -- only stops the LOG LINES. It cannot stop the requests,
   * because by the time it runs the request has already been made.
   *
   * So the budget has to be on both sides, and the two are not redundant: the
   * server's protects the log from any client, and this one protects the
   * transport from our own retry loop. Identical reports are also dropped,
   * because a remount loop produces the same five fields every time and the
   * second copy says nothing the first did not.
   *
   * Everything here is inside the try: this runs in the last-resort boundary,
   * and the budget must not become the thing that throws.
   */
  try {
    const body = JSON.stringify(report);
    if (reportsSeen.includes(body)) return;
    if (reportsSent >= REPORTER_BUDGET) return;
    reportsSent += 1;
    reportsSeen.push(body);
    void fetch(CLIENT_FAILURE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store"
    }).catch(() => undefined);
  } catch {
    /* No global fetch, a blocked request, a CSP refusal: all non-events here. */
  }
}
