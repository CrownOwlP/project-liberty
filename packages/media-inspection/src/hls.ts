import { Parser } from "m3u8-parser";
import { readDeclaredCodecs } from "./codecs";
import { checkUrlStatically } from "./egress";
import { buildRendition, readFrameRate, readPositiveInteger, type RawDeclaration } from "./rendition";
import { canonicaliseRenditions } from "./order";
import type {
  DeclaredRendition,
  InspectionReason,
  ManifestParseContext,
  ParsedLadder,
  RenditionLocation
} from "./types";

/* -------------------------------------------------------------------------
 * HLS: the declared ladder out of a master playlist.
 *
 * WHY A PARSER RATHER THAN `ffprobe`. `hls_read_header()` opens the first
 * segment of every selected playlist, so probing a master playlist downloads
 * real media. `#EXT-X-STREAM-INF` already declares `BANDWIDTH`, `RESOLUTION`,
 * `CODECS` and `FRAME-RATE`, so one small GET returns the WHOLE ladder instead
 * of megabytes returning one variant -- and it removes the TS and DASH demuxer
 * CVE surface from the hot path entirely.
 *
 * WHY `m3u8-parser` RATHER THAN A LINE SPLIT. The attribute-list grammar is the
 * part that is easy to get subtly wrong: `CODECS="avc1.4d401f,mp4a.40.2"`
 * contains a comma inside quotes, values may or may not be quoted per attribute,
 * and unknown tags must be skipped rather than fatal. `m3u8-parser` is
 * Apache-2.0, is what video.js VHS runs on, and -- the property that matters for
 * hostile input -- it is a lenient scanner that produces an empty manifest for
 * nonsense instead of throwing.
 *
 * It is pinned to an EXACT version rather than a caret range. It parses
 * attacker-influenced text in a security-reviewed service; a patch release
 * arriving silently is a change to that parser without a review, and the whole
 * reason this package exists is that its inputs are hostile.
 *
 * WHAT IS DELIBERATELY NOT READ:
 *
 *   - `#EXT-X-MEDIA` alternate renditions. They declare a language, a name and a
 *     group, and no media fact this shape reports -- no codec, no bitrate, no
 *     geometry. Including them would add rows in which every fact is unknown,
 *     which is noise dressed as coverage.
 *   - `#EXT-X-I-FRAME-STREAM-INF`. Trick-play playlists are not rungs of the
 *     playback ladder and a consumer ranking candidates must never select one.
 * ---------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/**
 * Reads one attribute, distinguishing absent from present-but-unusable.
 *
 * `hasOwnProperty.call` rather than `in` or a truthiness test. `parseAttributes`
 * writes every key a publisher supplied straight onto a plain object, so `in`
 * would report `constructor` and `toString` as declared attributes on every
 * manifest ever written. (The same write path is why `__proto__=...` in an
 * attribute list is inert: the parser assigns a STRING, and assigning a string
 * to `__proto__` is a no-op rather than a prototype swap. It is worth knowing
 * that this holds by luck of the value type, not by design, which is a second
 * reason not to reach values through the prototype chain here.)
 *
 * A present value of some other shape -- an object, a `Uint32Array` from a
 * parsed IV, `undefined` -- comes back as `""`, which the readers treat as
 * present-and-unreadable. That is the honest classification: something was
 * declared and we could not use it.
 */
function rawAttribute(record: Record<string, unknown> | null, key: string): RawDeclaration {
  if (record === null) return null;
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = record[key];
  if (typeof value === "number" || typeof value === "string") return value;
  return "";
}

function hasOwn(record: Record<string, unknown> | null, key: string): boolean {
  return record !== null && Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * One half of a `RESOLUTION`.
 *
 * `m3u8-parser` splits `1920x1080` into `{ width, height }` and, for a malformed
 * `1920x`, produces `{ width }` with no `height`. The attribute WAS declared in
 * that case, so the missing half is unreadable rather than absent -- reporting
 * it as absent would file a broken publisher under "said nothing".
 */
function resolutionHalf(
  attributes: Record<string, unknown> | null,
  key: "width" | "height"
): RawDeclaration {
  if (!hasOwn(attributes, "RESOLUTION")) return null;
  const resolution = asRecord(attributes === null ? null : attributes["RESOLUTION"]);
  if (resolution === null) return "";
  const half = rawAttribute(resolution, key);
  return half === null ? "" : half;
}

/**
 * Builds the location of a variant, and evaluates the URI it declares.
 *
 * THE URI IS UNTRUSTED INPUT. For HLS the input is second-order: whoever
 * controls the master playlist controls every URL a follow-up would open, so a
 * variant URI is exactly as attacker-shaped as the manifest URL was, and it goes
 * back through the same policy rather than inheriting the master's clearance.
 * `resolvedUrl` is populated only when that policy allows the target, so this
 * function can never hand a caller a ready-to-use URL that was not checked.
 */
function locationFor(uri: string | null, context: ManifestParseContext): RenditionLocation {
  // NOT REACHABLE THROUGH `m3u8-parser`, AND KEPT ANYWAY. That library appends a
  // playlist entry only from its `uri` handler, and it emits no `uri` event for
  // a blank line or a comment -- so a `#EXT-X-STREAM-INF` with nothing usable
  // after it yields NO entry at all rather than an entry with a missing URI.
  // (`hls.test.ts` pins that: `#EXTM3U\n#EXT-X-STREAM-INF:\n` parses to an empty
  // ladder.) The branch stays because `uri` is derived defensively from an
  // attribute read that returns `null` for anything that is not a usable string,
  // so this is the only total answer for the case; deleting it would move the
  // decision into `parseHlsLadder`, where the choice would be to drop the
  // variant silently. It is a fallback for a parser that behaves differently,
  // not a description of the one we depend on. See `RenditionLocation`.
  if (uri === null) return { kind: "not_declared" };

  const { egress, classifyHost, baseUrl } = context;
  if (egress === null || classifyHost === null) {
    return {
      kind: "declared",
      declaredUri: uri,
      resolvedUrl: null,
      verdict: { allowed: false, reason: "not_evaluated" }
    };
  }

  const verdict = checkUrlStatically(uri, egress, classifyHost, baseUrl ?? undefined);
  if (!verdict.ok) {
    return {
      kind: "declared",
      declaredUri: uri,
      resolvedUrl: null,
      verdict: { allowed: false, reason: verdict.reason }
    };
  }

  return {
    kind: "declared",
    declaredUri: uri,
    resolvedUrl: verdict.url.toString(),
    verdict: { allowed: true, obligation: "revalidate_before_fetch" }
  };
}

const HLS_EVIDENCE = {
  videoCodec: "#EXT-X-STREAM-INF:CODECS",
  audioCodec: "#EXT-X-STREAM-INF:CODECS",
  width: "#EXT-X-STREAM-INF:RESOLUTION",
  height: "#EXT-X-STREAM-INF:RESOLUTION",
  frameRate: "#EXT-X-STREAM-INF:FRAME-RATE",
  bandwidthBps: "#EXT-X-STREAM-INF:BANDWIDTH"
} as const;

export function parseHlsLadder(text: string, context: ManifestParseContext): ParsedLadder {
  let manifest: unknown;
  try {
    const parser = new Parser();
    parser.push(text);
    parser.end();
    manifest = parser.manifest;
  } catch (error) {
    // The library is a lenient scanner and is not expected to throw, which is
    // exactly why this is here: an unexpected throw on hostile input is the
    // shape a parser CVE takes, and it must be an outcome with a reason rather
    // than an exception escaping into a playback request. The error is named by
    // its type only -- a parser's message tends to quote the document it choked
    // on, and here that document is a third party's.
    return {
      renditions: [],
      reasons: [
        {
          code: "manifest_unparseable",
          detail: `HLS parser threw ${error instanceof Error ? error.name : typeof error}`
        }
      ]
    };
  }

  const root = asRecord(manifest);
  const playlists = asArray(root === null ? null : root["playlists"]);
  const segments = asArray(root === null ? null : root["segments"]);

  if (playlists === null || playlists.length === 0) {
    // A MEDIA playlist is a valid, well-formed document that simply declares no
    // ladder -- it is one rendition's segment list. Saying so is different from
    // saying the manifest was empty or broken, and a caller deciding whether to
    // retry needs the difference.
    const declaresSegments = segments !== null && segments.length > 0;
    const reason: InspectionReason = declaresSegments
      ? {
          code: "media_playlist_declares_no_ladder",
          detail: "the document is a media playlist; only a master playlist declares a ladder"
        }
      : { code: "no_renditions_declared", detail: "no #EXT-X-STREAM-INF tags were present" };
    return { renditions: [], reasons: [reason] };
  }

  // BEFORE A SINGLE RUNG IS BUILT, and that is the entire value of the check.
  // The count a publisher declared is the size of everything that follows --
  // one `buildRendition` and one `checkUrlStatically` per entry, then a sort
  // whose comparator stringifies several fields per comparison. Nothing bounds
  // that in time: `http.ts` clears its deadline when the body arrives, so the
  // parse phase runs to completion however long it takes. Refusing on the
  // declared count is what keeps a manifest from choosing how much CPU this
  // process spends. See `ManifestParseContext.maxRenditions`.
  if (playlists.length > context.maxRenditions) {
    return {
      renditions: [],
      reasons: [
        {
          code: "too_many_renditions",
          detail: `${playlists.length} declared renditions exceeds the cap of ${context.maxRenditions}`
        }
      ]
    };
  }

  const renditions: DeclaredRendition[] = [];

  for (const entry of playlists) {
    const playlist = asRecord(entry);
    const attributes = asRecord(playlist === null ? null : playlist["attributes"]);

    const unreadableDeclarations: string[] = [];

    const bandwidth = readPositiveInteger(rawAttribute(attributes, "BANDWIDTH"));
    if (bandwidth.unreadable) unreadableDeclarations.push("BANDWIDTH");

    const width = readPositiveInteger(resolutionHalf(attributes, "width"));
    const height = readPositiveInteger(resolutionHalf(attributes, "height"));
    if (width.unreadable || height.unreadable) unreadableDeclarations.push("RESOLUTION");

    const frameRate = readFrameRate(rawAttribute(attributes, "FRAME-RATE"));
    if (frameRate.unreadable) unreadableDeclarations.push("FRAME-RATE");

    const codecsRaw = rawAttribute(attributes, "CODECS");
    const codecsText =
      typeof codecsRaw === "string" && codecsRaw.trim() !== "" ? codecsRaw.trim() : null;
    if (codecsRaw !== null && codecsText === null) unreadableDeclarations.push("CODECS");

    const uriRaw = rawAttribute(playlist, "uri");
    const uri = typeof uriRaw === "string" && uriRaw.trim() !== "" ? uriRaw.trim() : null;

    renditions.push(
      buildRendition({
        // A `#EXT-X-STREAM-INF` describes a whole presentation by definition, so
        // this is reading the format rather than inferring from content. If the
        // `CODECS` list names only a video codec the audio fact is simply
        // unknown, which is the truthful outcome for a playlist using a separate
        // `AUDIO` group.
        kind: "multiplexed",
        location: locationFor(uri, context),
        codecs: readDeclaredCodecs(codecsText),
        width: width.value,
        height: height.value,
        frameRate: frameRate.value,
        bandwidthBps: bandwidth.value,
        unreadableDeclarations,
        evidenceDetail: HLS_EVIDENCE,
        observedAt: context.observedAt
      })
    );
  }

  const canonical = canonicaliseRenditions(renditions);
  return {
    renditions: canonical,
    reasons:
      canonical.length === 0
        ? [{ code: "no_renditions_declared", detail: "no #EXT-X-STREAM-INF tags were present" }]
        : []
  };
}
