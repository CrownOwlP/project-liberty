/* -------------------------------------------------------------------------
 * Per-track buffered ranges — and the intersection trap
 *
 * THE SINGLE MOST IMPORTANT CORRECTNESS DETAIL IN PL-0504:
 * `HTMLMediaElement.buffered` IS THE INTERSECTION OF ALL SOURCEBUFFERS.
 *
 * The whole point of the video-hole detector is to compare what the VIDEO
 * SourceBuffer holds against what the AUDIO SourceBuffer holds. Read from
 * `video.buffered`, both comparands are the same intersected range set, every
 * hole in either track has already been subtracted from both, and the detector
 * can only ever answer "no". It would not be a weak measurement; it would be a
 * detector that is structurally incapable of firing while looking like it
 * works. Every published A/V-gap bug of this class has been found by reading
 * `sourceBuffer.buffered` per track.
 *
 * SO THE TYPE SYSTEM DOES THE ENFORCING. There are two reading constructors and
 * they return two unrelated types:
 *
 *   - `readSourceBufferRanges("video", sb.buffered)` returns
 *     `TrackBufferedReading<"video">`, tagged `source: "source-buffer"`, and it
 *     is generic in the track so the video and audio arguments of
 *     `detectVideoHole` cannot be swapped either.
 *   - `readElementBufferedRanges(video.buffered)` returns
 *     `ElementBufferedReading`, tagged `source: "media-element-intersection"`,
 *     with no `track` field. It is NOT assignable to a detector input. It
 *     exists so that a caller who only has the element has something honest to
 *     hold, and `elementBufferedIsIntersection()` is the reason it hands the
 *     report instead.
 *
 * `sourceBuffer.buffered` is reachable through
 * `PlaybackController.getEnginePlayer()`, which that file already documents as
 * the escape hatch for exactly this: "the per-SourceBuffer buffered ranges all
 * hang off the real player". No edit to the controller is needed.
 *
 * UNITS. Every number in this file is SECONDS on the media timeline, which is
 * what `TimeRanges` reports, and every field says so in its name. Nothing here
 * is milliseconds.
 * ---------------------------------------------------------------------- */

import { avReason, AV_PROXY_METRICS, type AvUnobservableSignal } from "./av-continuity";
import { finiteOrNull, formatSeconds } from "./readers";

export type AvTrackKind = "video" | "audio";

export interface BufferedRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * Ranges read from ONE SourceBuffer, with the track it belongs to attached at
 * the moment of reading — because that is the only moment anyone knows.
 */
export interface TrackBufferedReading<TTrack extends AvTrackKind = AvTrackKind> {
  readonly source: "source-buffer";
  readonly track: TTrack;
  readonly ranges: readonly BufferedRange[];
}

/**
 * Ranges read from `HTMLMediaElement.buffered`.
 *
 * Deliberately a dead end. Nothing in this directory accepts one.
 */
export interface ElementBufferedReading {
  readonly source: "media-element-intersection";
  readonly ranges: readonly BufferedRange[];
}

/** The `TimeRanges` surface, structurally, so tests need no DOM. */
export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * `TimeRanges` to plain data, defensively.
 *
 * `start()` and `end()` throw `IndexSizeError` for an out-of-range index, and
 * the length can change between the read of `length` and the read of the last
 * range while the buffer is being appended to. A diagnostic that throws inside
 * a playback tick takes playback down with it, so a range that cannot be read
 * is dropped rather than propagated. Non-finite and inverted ranges are dropped
 * on the same footing — an inverted range is not a short range, it is a read
 * that did not mean anything.
 */
export function readTimeRanges(ranges: TimeRangesLike | null | undefined): BufferedRange[] {
  const length = finiteOrNull(ranges?.length);
  if (ranges === null || ranges === undefined || length === null) return [];

  const out: BufferedRange[] = [];
  for (let index = 0; index < length; index += 1) {
    let startSeconds: number | null = null;
    let endSeconds: number | null = null;
    try {
      startSeconds = finiteOrNull(ranges.start(index));
      endSeconds = finiteOrNull(ranges.end(index));
    } catch {
      continue;
    }
    if (startSeconds === null || endSeconds === null) continue;
    if (endSeconds < startSeconds) continue;
    out.push({ startSeconds, endSeconds });
  }
  return out;
}

/** The only constructor a detector will accept. See the file header. */
export function readSourceBufferRanges<TTrack extends AvTrackKind>(
  track: TTrack,
  ranges: TimeRangesLike | null | undefined
): TrackBufferedReading<TTrack> {
  return { source: "source-buffer", track, ranges: readTimeRanges(ranges) };
}

/** The constructor that produces something no detector will accept. */
export function readElementBufferedRanges(
  ranges: TimeRangesLike | null | undefined
): ElementBufferedReading {
  return { source: "media-element-intersection", ranges: readTimeRanges(ranges) };
}

/**
 * What to report when the per-track buffers were not reachable.
 *
 * The honest answer is "not observed", and it is a finding rather than an
 * omission so that a report from a platform where Shaka fell back to native
 * `src=` HLS — where there are no SourceBuffers at all — says so out loud
 * instead of looking like a clean run. The `detail` is the caller's, because
 * only the caller knows which of those it was.
 */
export function perTrackBufferedUnavailable(detail: string): AvUnobservableSignal {
  return {
    evidenceBasis: "unobservable",
    metric: AV_PROXY_METRICS.videoHole,
    evidenceSource: "no-evidence-available",
    reasons: [avReason("buffered_ranges_unusable", detail)]
  };
}

/**
 * The narrower statement: the caller HAD ranges, and they were the element's.
 *
 * Split from `perTrackBufferedUnavailable` above because
 * `element_buffered_is_intersection` is a specific accusation — it says a
 * reading was taken from `HTMLMediaElement.buffered` and is therefore incapable
 * of showing a video-only gap. Emitting it for a caller who supplied no ranges
 * at all attributes a mistake nobody made, and a reason trail that names the
 * wrong cause is worse than one that says less: the first thing anybody reading
 * it will do is go looking for the `video.buffered` call that is not there.
 */
export function elementBufferedIsIntersection(detail: string): AvUnobservableSignal {
  return {
    evidenceBasis: "unobservable",
    metric: AV_PROXY_METRICS.videoHole,
    evidenceSource: "no-evidence-available",
    reasons: [
      avReason("element_buffered_is_intersection", detail),
      avReason(
        "buffered_ranges_unusable",
        "HTMLMediaElement.buffered is the intersection of every SourceBuffer, so a video-only " +
          "gap has already been subtracted from it. The video hole proxy needs " +
          "sourceBuffer.buffered per track and was not given it."
      )
    ]
  };
}

/**
 * Sorted, coalesced, canonical.
 *
 * ORDER-INDEPENDENCE IS THE REASON THIS EXISTS. `TimeRanges` is specified as
 * ordered, but the detector's answer must not depend on trusting that, on a
 * caller having concatenated two readings, or on a range set that a test
 * happened to write in a different order. Six order-dependence defects in this
 * project have been of exactly this shape, so the canonical form is computed
 * rather than assumed: sort by start then end, then merge any two ranges whose
 * separation is at or below `coalesceSeconds`.
 *
 * The coalesce tolerance is not cosmetic either. fMP4 segment boundaries land a
 * few microseconds apart after timescale conversion, and without it every
 * segment boundary in the stream is a candidate hole.
 */
export function normaliseRanges(
  ranges: readonly BufferedRange[],
  coalesceSeconds: number
): readonly BufferedRange[] {
  const tolerance = Math.max(finiteOrNull(coalesceSeconds) ?? 0, 0);

  const sorted = [...ranges].sort((left, right) =>
    left.startSeconds === right.startSeconds
      ? left.endSeconds - right.endSeconds
      : left.startSeconds - right.startSeconds
  );

  const merged: BufferedRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.startSeconds - previous.endSeconds <= tolerance) {
      if (range.endSeconds > previous.endSeconds) {
        merged[merged.length - 1] = {
          startSeconds: previous.startSeconds,
          endSeconds: range.endSeconds
        };
      }
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/**
 * The gaps between consecutive normalised ranges, in timeline order.
 *
 * Only interior gaps. The unbuffered region before the first range and after
 * the last one is not a hole — it is the buffer's edge, which is where every
 * stream lives and is PL-0502's starvation concern rather than this one.
 */
export function gapsBetween(ranges: readonly BufferedRange[]): readonly BufferedRange[] {
  const gaps: BufferedRange[] = [];
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const next = ranges[index];
    if (previous === undefined || next === undefined) continue;
    if (next.startSeconds > previous.endSeconds) {
      gaps.push({ startSeconds: previous.endSeconds, endSeconds: next.startSeconds });
    }
  }
  return gaps;
}

/** Whether an instant falls inside any of the (normalised) ranges. */
export function containsInstant(
  ranges: readonly BufferedRange[],
  positionSeconds: number
): boolean {
  return ranges.some(
    (range) => positionSeconds >= range.startSeconds && positionSeconds <= range.endSeconds
  );
}

/**
 * Whether ONE range covers the whole interval.
 *
 * "One range" rather than "the union of ranges" is the load-bearing part: an
 * interval covered by two adjacent ranges is covered by a track that is itself
 * discontinuous there, which is not the contiguity the video-hole rule asks
 * about. `normaliseRanges` has already merged anything within tolerance, so a
 * boundary that survives to here is a real one.
 *
 * The margin is a tolerance, not an expansion: it makes the requirement
 * slightly easier to satisfy, so float noise at a segment boundary cannot
 * suppress a genuine detection.
 */
export function spansInterval(
  ranges: readonly BufferedRange[],
  startSeconds: number,
  endSeconds: number,
  marginSeconds: number
): boolean {
  const margin = Math.max(finiteOrNull(marginSeconds) ?? 0, 0);
  return ranges.some(
    (range) =>
      range.startSeconds <= startSeconds + margin && range.endSeconds >= endSeconds - margin
  );
}

/** A reason-string fragment describing a range set, deterministically. */
export function describeRanges(ranges: readonly BufferedRange[]): string {
  if (ranges.length === 0) return "no buffered ranges";
  return ranges
    .map((range) => `[${formatSeconds(range.startSeconds)}, ${formatSeconds(range.endSeconds)}]`)
    .join(" ");
}
