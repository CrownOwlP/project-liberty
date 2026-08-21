import { describe, expect, it } from "vitest";
import {
  containsInstant,
  gapsBetween,
  normaliseRanges,
  readElementBufferedRanges,
  readSourceBufferRanges,
  readTimeRanges,
  spansInterval,
  type BufferedRange,
  type TimeRangesLike
} from "./buffered-ranges";

/**
 * A `TimeRanges` stand-in. `apps/web` runs vitest in the `node` environment
 * with no jsdom, so every DOM-shaped input in this directory is injected as a
 * structural fake rather than constructed.
 */
function fakeTimeRanges(ranges: readonly (readonly [number, number])[]): TimeRangesLike {
  return {
    length: ranges.length,
    start: (index) => {
      const range = ranges[index];
      if (range === undefined) throw new Error("IndexSizeError");
      return range[0];
    },
    end: (index) => {
      const range = ranges[index];
      if (range === undefined) throw new Error("IndexSizeError");
      return range[1];
    }
  };
}

describe("reading TimeRanges", () => {
  it("converts every range, keeping seconds in the field names", () => {
    expect(readTimeRanges(fakeTimeRanges([[0, 10], [12, 20]]))).toEqual([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 12, endSeconds: 20 }
    ]);
  });

  it("drops a range that throws rather than taking playback down with it", () => {
    // `start()`/`end()` throw IndexSizeError, and the buffer can be appended to
    // between the read of `length` and the read of the last range.
    const unstable: TimeRangesLike = {
      length: 2,
      start: (index) => (index === 0 ? 0 : Number.NaN),
      end: (index) => {
        if (index === 1) throw new Error("IndexSizeError");
        return 10;
      }
    };
    expect(readTimeRanges(unstable)).toEqual([{ startSeconds: 0, endSeconds: 10 }]);
  });

  it("drops non-finite and inverted ranges instead of propagating them", () => {
    const ranges = readTimeRanges(
      fakeTimeRanges([
        [Number.NaN, 5],
        [8, 6],
        [10, 12]
      ])
    );
    expect(ranges).toEqual([{ startSeconds: 10, endSeconds: 12 }]);
  });

  it("reads nothing from a null or absent TimeRanges", () => {
    expect(readTimeRanges(null)).toEqual([]);
    expect(readTimeRanges(undefined)).toEqual([]);
  });
});

describe("the buffered-intersection trap", () => {
  it("tags a per-SourceBuffer reading with its track at the moment of reading", () => {
    const reading = readSourceBufferRanges("video", fakeTimeRanges([[0, 10]]));
    expect(reading.source).toBe("source-buffer");
    expect(reading.track).toBe("video");
  });

  it("tags an element reading as the intersection it is", () => {
    // `HTMLMediaElement.buffered` is the INTERSECTION of all SourceBuffers, so
    // the reading that comes from it is a different type with no `track` field
    // and is not assignable to any detector input. See the two @ts-expect-error
    // assertions in `video-hole.test.ts`, which hold that at compile time.
    const reading = readElementBufferedRanges(fakeTimeRanges([[0, 10]]));
    expect(reading.source).toBe("media-element-intersection");
    expect(reading).not.toHaveProperty("track");
  });
});

describe("normalisation is order-independent", () => {
  const canonical: readonly BufferedRange[] = [
    { startSeconds: 0, endSeconds: 10 },
    { startSeconds: 12, endSeconds: 20 }
  ];

  it("produces the same canonical form whatever order the ranges arrive in", () => {
    const shuffled: readonly BufferedRange[] = [
      { startSeconds: 12, endSeconds: 20 },
      { startSeconds: 0, endSeconds: 10 }
    ];
    expect(normaliseRanges(shuffled, 0.01)).toEqual(canonical);
    expect(normaliseRanges(canonical, 0.01)).toEqual(canonical);
  });

  it("coalesces ranges separated by less than the tolerance", () => {
    // fMP4 segment boundaries land microseconds apart after timescale
    // conversion. Without this, every segment boundary is a candidate hole.
    const ranges = normaliseRanges(
      [
        { startSeconds: 0, endSeconds: 9.999_5 },
        { startSeconds: 10, endSeconds: 20 }
      ],
      0.01
    );
    expect(ranges).toEqual([{ startSeconds: 0, endSeconds: 20 }]);
  });

  it("does not coalesce across a separation larger than the tolerance", () => {
    const ranges = normaliseRanges(
      [
        { startSeconds: 0, endSeconds: 10 },
        { startSeconds: 10.5, endSeconds: 20 }
      ],
      0.01
    );
    expect(ranges).toHaveLength(2);
  });

  it("merges overlapping ranges and keeps the furthest end", () => {
    const ranges = normaliseRanges(
      [
        { startSeconds: 0, endSeconds: 30 },
        { startSeconds: 5, endSeconds: 10 }
      ],
      0
    );
    expect(ranges).toEqual([{ startSeconds: 0, endSeconds: 30 }]);
  });
});

describe("gaps, instants and intervals", () => {
  it("reports only interior gaps, never the buffer edge", () => {
    // The unbuffered region before the first range and after the last is the
    // buffer's edge, which every stream has. It is starvation, not a hole.
    expect(
      gapsBetween([
        { startSeconds: 5, endSeconds: 10 },
        { startSeconds: 12, endSeconds: 20 }
      ])
    ).toEqual([{ startSeconds: 10, endSeconds: 12 }]);
    expect(gapsBetween([{ startSeconds: 5, endSeconds: 10 }])).toEqual([]);
  });

  it("answers whether an instant is buffered", () => {
    const ranges = [{ startSeconds: 0, endSeconds: 10 }];
    expect(containsInstant(ranges, 5)).toBe(true);
    expect(containsInstant(ranges, 11)).toBe(false);
  });

  it("requires ONE range to span an interval, not the union of several", () => {
    // An interval covered by two adjacent ranges is covered by a track that is
    // itself discontinuous there, which is not the contiguity the video-hole
    // rule asks about.
    const split = [
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 10.5, endSeconds: 20 }
    ];
    expect(spansInterval(split, 9, 11, 0)).toBe(false);
    expect(spansInterval([{ startSeconds: 0, endSeconds: 20 }], 9, 11, 0)).toBe(true);
  });

  it("treats the margin as a tolerance, so float noise cannot suppress a detection", () => {
    const ranges = [{ startSeconds: 10.000_1, endSeconds: 19.999_9 }];
    expect(spansInterval(ranges, 10, 20, 0)).toBe(false);
    expect(spansInterval(ranges, 10, 20, 0.02)).toBe(true);
  });
});
