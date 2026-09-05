/* -------------------------------------------------------------------------
 * Whether this session gets telemetry, and why (PL-0503)
 *
 * `telemetry.ts` is the configuration seam: it turns validated options into
 * Shaka's `cmcd` block, and it returns `CMCD_DISABLED` rather than throwing
 * when an option is unusable, because a telemetry misconfiguration must not be
 * able to take playback down. That is the right behaviour and this file does not
 * change it. What it adds is the missing half: WHICH refusal happened.
 *
 * A DISABLED BLOCK IS AN ANSWER WITH NO REASON ATTACHED. `playbackTelemetryConfig`
 * returns the same `{ cmcd: { enabled: false } }` for a content id that looks
 * like a URL, a session id nobody could mint, a collector path that would resolve
 * cross-origin, and a caller that simply asked for it to be off. Product
 * invariant 4 asks a playback decision to expose a trail sufficient to debug it,
 * and "telemetry is off and nobody knows why" is how an observability pipeline
 * becomes unfalsifiable -- the operator cannot tell a deliberate opt-out from a
 * silent misconfiguration. So the guards `telemetry.ts` already exports are run
 * here FIRST, each producing a reason, and the seam is then called with options
 * it has already agreed to.
 *
 * THE GUARDS ARE THE SAME FUNCTIONS, NOT A COPY OF THEM.
 * `isTransmittableIdentifier` and `isFirstPartyCollectorPath` are exported from
 * `telemetry.ts` precisely so "a caller that would rather fail loudly than
 * silently lose telemetry can check before calling". Re-implementing either
 * would create a second opinion about what may reach the CDN, and the whole
 * point of validating `cid` and `sid` is that there is exactly one.
 *
 * WHY THE IDENTIFIERS COME BACK OUT. `identifiers` is non-null only on the
 * enabled branch, and only carries values both guards accepted. PL-0504's
 * diagnostics emitter needs `cid` and `sid` to correlate its report with the
 * CMCD stream, and this is the only place in the player that has decided they
 * are safe to send. Handing it the raw props instead would be a second,
 * unguarded path for an identifier to leave the browser -- which is the defect
 * `isTransmittableIdentifier` exists to prevent, reintroduced one file over.
 *
 * NOTHING HERE READS A CLOCK. `mintTelemetrySessionId` reads a random source,
 * and it takes that source as an argument for the same reason: a caller can
 * supply a fake and pin the result.
 * ---------------------------------------------------------------------- */

import type { EngineConfig } from "./engine";
import {
  CMCD_DISABLED,
  PLAYBACK_TELEMETRY_DEFAULTS,
  isFirstPartyCollectorPath,
  isTransmittableIdentifier,
  playbackTelemetryConfig
} from "./telemetry";

/**
 * The collector, as a same-origin path.
 *
 * Declared here rather than imported from the route, because importing anything
 * out of `app/api/**` into a client component would pull that module's server
 * dependencies -- zod, and the observability sink -- into the browser bundle.
 * The two are kept honest by a test in the route's own directory that derives
 * this path from its own location on disk and compares.
 */
export const CMCD_COLLECTOR_PATH = "/api/v1/telemetry/cmcd";

export type PlaybackTelemetryReasonCode =
  /* Telemetry is on. */
  | "cmcd_configured"
  /* Off because it was asked to be. */
  | "telemetry_disabled"
  /* Off because something would have been unsafe or useless to send. */
  | "session_id_unavailable"
  | "session_id_not_transmittable"
  | "content_id_not_transmittable"
  | "collector_path_not_first_party"
  | "client_key_allowlist_empty";

export interface PlaybackTelemetryReason {
  readonly code: PlaybackTelemetryReasonCode;
  readonly detail: string;
}

/** Never empty, on either branch. See the file header. */
export type PlaybackTelemetryReasons = readonly [
  PlaybackTelemetryReason,
  ...PlaybackTelemetryReason[]
];

/** The two identifiers that reach the CDN, after both have been validated. */
export interface PlaybackTelemetryIdentifiers {
  readonly contentId: string;
  readonly sessionId: string;
}

export interface PlaybackTelemetryDecision {
  readonly enabled: boolean;
  /**
   * Always a fragment to apply, never absent.
   *
   * `PlaybackController` replays its configuration history onto every player it
   * builds, so an ABSENT `cmcd` block leaves whatever a previous call set in
   * force. Saying `enabled: false` is the only way to actually turn it off, and
   * the refused branch therefore carries `CMCD_DISABLED` rather than `null`.
   */
  readonly config: EngineConfig;
  /** Non-null only when `enabled`. Both values passed `isTransmittableIdentifier`. */
  readonly identifiers: PlaybackTelemetryIdentifiers | null;
  readonly reasons: PlaybackTelemetryReasons;
}

export interface PlaybackTelemetryInput {
  /** A deliberate opt-out. Produces its own reason rather than an empty trail. */
  readonly enabled: boolean;
  readonly contentId: string;
  /**
   * `null` means no session id could be minted -- see `mintTelemetrySessionId`.
   *
   * Required-and-nullable rather than optional, matching the rule this
   * repository states for unknown facts: `null` says the caller looked and
   * there was nothing, an absent key says only that nobody thought about it.
   */
  readonly sessionId: string | null;
  readonly collectorPath: string;
  readonly batchSize: number;
  readonly intervalSeconds: number;
}

function reason(code: PlaybackTelemetryReasonCode, detail: string): PlaybackTelemetryReason {
  return { code, detail };
}

function refused(primary: PlaybackTelemetryReason): PlaybackTelemetryDecision {
  return { enabled: false, config: CMCD_DISABLED, identifiers: null, reasons: [primary] };
}

/**
 * Whether an engine fragment actually switches CMCD on.
 *
 * Read defensively rather than compared against `CMCD_DISABLED` by value:
 * `EngineConfig` is `Readonly<Record<string, unknown>>`, so a structural
 * comparison would be an equality test against a shape that is allowed to grow.
 */
function isCmcdEnabled(config: EngineConfig): boolean {
  const block: unknown = config["cmcd"];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return false;
  return (block as Record<string, unknown>)["enabled"] === true;
}

/**
 * Decide, and say why.
 *
 * Total: every branch returns a decision, and none of the guards it calls
 * throws. A caller applies `decision.config` unconditionally.
 */
export function decidePlaybackTelemetry(
  input: PlaybackTelemetryInput
): PlaybackTelemetryDecision {
  if (!input.enabled) {
    return refused(
      reason(
        "telemetry_disabled",
        "Playback telemetry was switched off for this session by its caller. This is a stated " +
          "opt-out, not a failure: the CMCD block is applied as `enabled: false` so a previously " +
          "configured player cannot keep reporting."
      )
    );
  }

  if (input.sessionId === null) {
    return refused(
      reason(
        "session_id_unavailable",
        "No playback session id could be minted, so there is nothing to correlate a report " +
          "against. CMCD is left off rather than handed an empty `sid`, which shaka-player reads " +
          "as an instruction to invent one -- and an id nobody chose is an id no server-side log " +
          "can be joined on."
      )
    );
  }

  if (!isTransmittableIdentifier(input.contentId, "cid")) {
    return refused(
      reason(
        "content_id_not_transmittable",
        "The content id is not safe to put in CMCD `cid`. That value travels to the CDN as a " +
          "query parameter on every manifest and segment request, so a URL, a locator or an " +
          "over-long string is refused rather than transmitted. See `isTransmittableIdentifier`."
      )
    );
  }

  if (!isTransmittableIdentifier(input.sessionId, "sid")) {
    return refused(
      reason(
        "session_id_not_transmittable",
        "The session id is not safe to put in CMCD `sid`, which reaches the CDN on every media " +
          "request. The bound is CTA-5004-B's own 64 characters, which a UUID clears and an " +
          "issued token does not."
      )
    );
  }

  if (!isFirstPartyCollectorPath(input.collectorPath)) {
    return refused(
      reason(
        "collector_path_not_first_party",
        "The collector target is not an absolute same-origin path. Event Mode POSTs the whole " +
          "CMCD dictionary to it, so a target that could resolve to another origin is refused " +
          "outright rather than sent a redacted subset."
      )
    );
  }

  const config = playbackTelemetryConfig({
    enabled: true,
    contentId: input.contentId,
    sessionId: input.sessionId,
    collectorPath: input.collectorPath,
    batchSize: input.batchSize,
    intervalSeconds: input.intervalSeconds
  });

  if (!isCmcdEnabled(config)) {
    /*
     * Every identifier and path refusal `playbackTelemetryConfig` makes has
     * already been evaluated above using the same exported guards, so a disabled
     * block at this point is its remaining one: the fail-closed on an empty
     * client key allowlist. That is not defensive padding -- shaka-player reads
     * an empty `includeKeys` as "unspecified" and substitutes every v2 key,
     * `url` and `nor` among them, so an allowlist that derived down to nothing
     * would not send nothing, it would send everything.
     */
    return refused(
      reason(
        "client_key_allowlist_empty",
        "The CMCD key allowlist derived from `@liberty/observability` is empty, so telemetry " +
          "fails closed. An empty allowlist is not an empty report to shaka-player, it is every " +
          "key including the URL-bearing ones."
      )
    );
  }

  return {
    enabled: true,
    config,
    identifiers: { contentId: input.contentId, sessionId: input.sessionId },
    reasons: [
      reason(
        "cmcd_configured",
        `CMCD v2 is on: batches of ${String(input.batchSize)} or every ` +
          `${String(input.intervalSeconds)}s, to ${input.collectorPath}, requesting only the ` +
          "keys the registry classifies as safe."
      )
    ]
  };
}

/**
 * A session id, or `null`.
 *
 * NEVER FABRICATED. `crypto.randomUUID` is only present in a secure context, so
 * a page served over plain HTTP to something that is not `localhost` genuinely
 * has no source of one here. The alternatives are all worse: `Math.random` is
 * not a correlation id anybody should trust to be unique across a fleet, a
 * counter is per-tab, and an empty string is what shaka-player treats as
 * "invent one for me" -- which produces an id no server-side log can be joined
 * against. So the honest answer is `null`, and `decidePlaybackTelemetry` turns
 * that into a stated refusal.
 *
 * The source is an argument rather than a global read, so this is a pure
 * function of it and a test can supply a fake without touching `globalThis`.
 */
export function mintTelemetrySessionId(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;

  const candidate: unknown = (source as Record<string, unknown>)["randomUUID"];
  if (typeof candidate !== "function") return null;

  // `.call(source)` rather than a bare call: `crypto.randomUUID` is a method and
  // detaching it from its receiver is not portable.
  const generate = candidate as (this: unknown) => unknown;
  let value: unknown;
  try {
    value = generate.call(source);
  } catch {
    /* A source that refuses is a source we do not have. Never a throw here: the
     * caller is on the path that starts playback. */
    return null;
  }

  return typeof value === "string" && value !== "" ? value : null;
}

/** The shipped cadence, re-exported so a caller configures one thing. */
export { PLAYBACK_TELEMETRY_DEFAULTS };
