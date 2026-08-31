/* -------------------------------------------------------------------------
 * CMCD v2 configuration for one playback session (PL-0503)
 *
 * THIS FILE IS A CONFIGURATION SEAM AND NOTHING ELSE. It has no transport, no
 * batching, no sequence numbers, no retry and no metric mapping, because
 * shaka-player 5.2.6 already has all five: it vendors the SVTA `@svta/cml-cmcd`
 * library and implements CMCD v2 including Event Mode, so the entire client
 * side of this task is an object handed to `PlaybackController.configure()`.
 * Writing a second telemetry pipeline beside it would be a spec-incorrect
 * reimplementation of code we already ship. `playback-stats.ts` normalises
 * `getStats()` for anything that wants a snapshot; this does not duplicate it.
 *
 * WHY NO OPENTELEMETRY HERE. `docs/RESEARCH_PLAYBACK.md` rules it out of the
 * player bundle explicitly: browser instrumentation is experimental, every OTLP
 * exporter is on the experimental track, and OTel is deprecating the Span
 * Events API in favour of logs. CMCD converts to OTel at the server boundary,
 * in `@liberty/observability`, where the Node SDK is stable.
 *
 * THE FOUR THINGS THIS FILE HAS TO GET RIGHT
 *
 *   - THE TARGET IS FIRST-PARTY OR THERE IS NO TARGET. Event Mode POSTs the
 *     whole CMCD dictionary to `url`, and CMCD carries the media URL under
 *     `url` and `nor` including any signed query string. So the collector is
 *     named by a same-origin PATH rather than by a URL, which makes a
 *     cross-origin target unrepresentable rather than merely discouraged.
 *   - THE KEY ALLOWLIST IS DERIVED, NOT WRITTEN. `includeKeys` comes from
 *     `CMCD_V2_CLIENT_SAFE_KEYS`, which `@liberty/observability` computes from
 *     the same registry its collector redacts with. The URL-bearing keys are
 *     therefore never requested AND redacted if they arrive anyway — two
 *     independent controls that cannot drift, because they are one declaration.
 *   - AN EMPTY ALLOWLIST IS NOT AN EMPTY REPORT, IT IS THE WHOLE VOCABULARY.
 *     `CmcdManager.toReporterConfig_` in shaka-player 5.2.6 reads an empty
 *     `includeKeys` as "unspecified" and substitutes `allKeysForVersion_(2)`,
 *     which includes `url` and `nor`. A derived list that filtered down to
 *     nothing would therefore fail OPEN, so emptiness disables CMCD here rather
 *     than being passed through. This is not hypothetical tidiness: the whole
 *     point of deriving the list is that a registry edit changes it.
 *   - `cid` AND `sid` LEAVE THE FIRST PARTY. This is the half of the leak
 *     argument the first-party collector path does not cover. With
 *     `useHeaders: false` and request mode enabled, Shaka appends `CMCD=<sfv>`
 *     as a QUERY PARAMETER to every manifest and segment request — which go to
 *     the CDN, not to us — and `cid` and `sid` are in every one of those
 *     dictionaries. So the two identifiers are cross-origin data by
 *     construction, and `isTransmittableIdentifier` refuses anything that could
 *     be a URL or a bearer credential rather than trusting the caller. The
 *     playback session id is a `crypto.randomUUID()` and passes; a signed
 *     manifest URL or an issued session token does not.
 *
 * NOTHING IN HERE READS A CLOCK OR A RANDOM SOURCE. `sessionId` is an input.
 * Shaka will mint one with `crypto.randomUUID()` if it is handed an empty
 * string, and a session id nobody chose is a session id nobody can correlate a
 * server-side log against.
 *
 * Field names verified against `shaka.extern.CmcdConfiguration` and
 * `shaka.extern.CmcdTarget` in shaka-player 5.2.6, and the defaults against
 * `lib/util/player_configuration.js`.
 * ---------------------------------------------------------------------- */

import {
  CMCD_REPORT_LIMITS,
  CMCD_V2_CLIENT_SAFE_KEYS,
  cmcdKeySpec,
  looksLikeUrl
} from "@liberty/observability";
import type { EngineConfig } from "./engine";

/**
 * The CMCD v2 event types we subscribe to, as `shaka.util.CmcdManager.EventType`
 * spells them.
 *
 * These four cover PL-0503's acceptance exactly: `ps` (play state) carries
 * `sta: "s"` for startup and `sta: "r"` for a rebuffer, `bc` is a bitrate
 * change, `e` is an error, and `t` is the periodic tick that carries the
 * session's accumulated QoE — `msd`, `ltc`, `dfa`, `bs` and the buffer
 * starvation family.
 *
 * `rr` (response received) is deliberately absent. It is the only event that
 * fires per HTTP response rather than per session state change, so subscribing
 * to it turns a handful of POSTs per session into one per segment batch, and
 * the `ttfb`/`ttlb` it would add are per-request facts that CDN logs already
 * hold. Adding it is one entry here if that trade ever changes.
 */
export const PLAYBACK_TELEMETRY_EVENTS: readonly string[] = ["ps", "bc", "e", "t"];

/**
 * Reporting cadence.
 *
 * `intervalSeconds` IS IN SECONDS, and it is the only number in this task that
 * is. Everything else — every CMCD key, every field `playback-stats.ts` emits —
 * is milliseconds. The unit is in the name here for the same reason it is in
 * the names there: `cml.cmcd.CMCD_DEFAULT_TIME_INTERVAL` is `30` and means
 * thirty seconds, and a reader who assumes this file's convention would read it
 * as thirty milliseconds and wonder why the collector is on fire.
 */
export const PLAYBACK_TELEMETRY_DEFAULTS = {
  batchSize: 10,
  intervalSeconds: 30
} as const;

export interface PlaybackTelemetryOptions {
  /** False produces an explicitly disabled block rather than an absent one. */
  readonly enabled: boolean;
  /**
   * CMCD `cid`. The catalog's content id, never a URL — and the "never" is
   * enforced by `isTransmittableIdentifier`, not requested in a comment,
   * because this value reaches the CDN.
   */
  readonly contentId: string;
  /**
   * CMCD `sid`. Supplied rather than generated; see the file header. An opaque
   * correlation id such as the playback session's `crypto.randomUUID()`, never
   * an issued token: this value reaches the CDN too.
   */
  readonly sessionId: string;
  /**
   * An absolute SAME-ORIGIN path, e.g. `/api/v1/telemetry/cmcd`. Not a URL:
   * see the file header for why the type is the control.
   */
  readonly collectorPath: string;
  readonly batchSize: number;
  readonly intervalSeconds: number;
}

/**
 * Turning CMCD off, stated rather than omitted.
 *
 * `PlaybackController` replays its configuration history onto every player it
 * constructs, so an ABSENT `cmcd` block leaves whatever a previous call set in
 * force. Saying `enabled: false` is the only way to actually turn it off.
 */
export const CMCD_DISABLED: EngineConfig = { cmcd: { enabled: false } };

/**
 * Whether a collector path can only ever resolve to our own origin.
 *
 * Three rejections, each for a real bypass rather than for tidiness:
 *   - anything not starting with `/` is a relative path or a full URL, and a
 *     full URL is a third-party target;
 *   - `//host/path` is a PROTOCOL-RELATIVE URL and resolves to `host`, not to
 *     us, despite looking like a path;
 *   - a backslash anywhere, because several URL parsers normalise `\` to `/`
 *     before resolving, which turns `/\evil.example.com` into `//evil.example.com`.
 */
export function isFirstPartyCollectorPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

/**
 * Whether a value is safe to put in `cid` or `sid`.
 *
 * These two travel to the CDN on every segment request; see the file header.
 * Four refusals, and each names a value somebody could plausibly pass:
 *
 *   - EMPTY. Shaka treats an empty `sid` as "mint me one", so an empty string
 *     is not a session id, it is a session id nobody can correlate against.
 *   - URL-SHAPED. `looksLikeUrl` is the same test `@liberty/observability`'s
 *     collector applies to custom-key values, reused rather than restated. A
 *     signed manifest URL passed as a content id would reproduce, through a key
 *     the registry classifies as safe, exactly the leak that classifying `url`
 *     and `nor` closes.
 *   - LOCATOR-SHAPED. `looksLikeUrl` tests for a SCHEME, so it does not see
 *     `//cdn.example.com/x.m3u8?Signature=…` — a protocol-relative URL, which is
 *     a perfectly ordinary way for a manifest reference to be written down. A
 *     value carrying `/` or `?` is a locator rather than an identifier, and the
 *     ids this platform actually issues are the lowercase-kebab slugs
 *     `normalizedContentIdSchema` already enforces plus a UUID, neither of which
 *     contains either character. Widening `looksLikeUrl` itself was rejected:
 *     it is shared with the collector's redaction path, where "contains a slash"
 *     would redact `cmsdd` header values that legitimately do.
 *   - LONGER THAN CTA-5004-B ALLOWS, with the bound READ FROM THE REGISTRY
 *     rather than written here, so it cannot drift from the one the collector
 *     truncates against. It is a length check doing double duty: 64 characters
 *     is a UUID with room to spare and is too short for a signed URL or a JWT,
 *     so a credential pasted into `sid` is refused by the spec's own bound
 *     rather than by a credential-detector we would have to keep current.
 *
 * Exported so a caller that would rather fail loudly than silently lose
 * telemetry can check before calling, exactly like `isFirstPartyCollectorPath`.
 */
export function isTransmittableIdentifier(value: string, key: "cid" | "sid"): boolean {
  if (value === "") return false;
  if (looksLikeUrl(value)) return false;
  if (value.includes("/") || value.includes("?")) return false;
  // The same fallback the collector's `safeString` uses, so a registry entry
  // that stops stating a length behaves identically at both ends.
  const limit = cmcdKeySpec(key)?.maxLength ?? CMCD_REPORT_LIMITS.maxStringLength;
  return value.length <= limit;
}

/**
 * The `cmcd` fragment for one session.
 *
 * Returns the DISABLED block rather than throwing when an input is unusable. A
 * telemetry misconfiguration must not be able to take playback down, and this
 * is called from the same place that decides whether there is a session at all.
 * `isFirstPartyCollectorPath` is exported so a caller that wants to fail loudly
 * can check first.
 */
export function playbackTelemetryConfig(options: PlaybackTelemetryOptions): EngineConfig {
  if (!options.enabled) return CMCD_DISABLED;
  if (!isTransmittableIdentifier(options.contentId, "cid")) return CMCD_DISABLED;
  if (!isTransmittableIdentifier(options.sessionId, "sid")) return CMCD_DISABLED;
  if (!isFirstPartyCollectorPath(options.collectorPath)) return CMCD_DISABLED;

  // Copied out of the readonly source so Shaka, which stores the array by
  // reference and mutates its own config tree, cannot reach the shared
  // declaration in `@liberty/observability`.
  const includeKeys = [...CMCD_V2_CLIENT_SAFE_KEYS];

  // FAIL CLOSED ON AN EMPTY ALLOWLIST. See the file header: Shaka expands an
  // empty `includeKeys` to every v2 key, `url` and `nor` among them, so the one
  // thing this must not do is pass the empty array through as though it meant
  // what it says.
  if (includeKeys.length === 0) return CMCD_DISABLED;

  return {
    cmcd: {
      enabled: true,
      /*
       * STATED BECAUSE SHAKA'S DEFAULT IS 1. `player_configuration.js` ships
       * `version: 1`, and v1 has no Event Mode, no `msd`, no `sta`, no `ec` and
       * no buffer starvation keys — so an omitted version here is not "the
       * modern default", it is silently the wrong protocol.
       */
      version: 2,
      contentId: options.contentId,
      sessionId: options.sessionId,
      /*
       * Query mode rather than headers. CMCD-as-headers on a media request is
       * a non-simple header, which makes every segment fetch preflight, and
       * segment fetches go to CDNs we do not control the CORS policy of.
       */
      useHeaders: false,
      includeKeys,
      eventTargets: [
        {
          enabled: true,
          mode: "event",
          url: options.collectorPath,
          events: [...PLAYBACK_TELEMETRY_EVENTS],
          includeKeys: [...includeKeys],
          useHeaders: false,
          // Seconds. See `PLAYBACK_TELEMETRY_DEFAULTS`.
          interval: options.intervalSeconds,
          batchSize: options.batchSize
        }
      ]
    }
  };
}
