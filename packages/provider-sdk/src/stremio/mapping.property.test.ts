import { unknownMediaFacts, type StreamCandidate } from "@liberty/contracts/domains/playback";
import type { AudioCodec, VideoCodec } from "@liberty/contracts/shared/codecs";
import { MEDIA_FACTS } from "@liberty/contracts/shared/media-facts";
import { PLAYABLE_CONTENT_RIGHTS, type ContentRights } from "@liberty/contracts/shared/rights";
import {
  audioCodecArb,
  contentRightsArb,
  defined,
  healthScoreArb,
  permutationKeysArb,
  permute,
  unvettedRightsArb,
  videoCodecArb
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deriveProtocol,
  mapStremioStreams,
  observeStreamMedia,
  observedHealthScore,
  resolveStreamMedia,
  stableStreamKey,
  type ObservedMedia,
  type RejectedStream,
  type StreamMappingContext
} from "./mapping";
import { compareCodePoint } from "./order";
import type { StremioStream } from "./protocol";

/**
 * Stremio mapping properties (fast-check).
 *
 * THE DEFECT THIS FILE EXISTS FOR. Duplicate stream-URL collapse used to fold
 * pairwise as streams arrived, so each rejection's `detail` named the incumbent
 * at that moment rather than the eventual survivor: three duplicates labelled A,
 * B and C arriving as [A,B,C] both read "duplicate of A", while arriving as
 * [B,C,A] one of them read "duplicate of B". Same input set, different
 * `StreamMappingBatch`.
 *
 * A TWO-DUPLICATE TEST CANNOT SEE THAT, because with two the incumbent at
 * rejection time is always the survivor — and a two-duplicate test is exactly
 * what the suite had. So the duplicate property below generates 0 to 5 copies and
 * compares the WHOLE batch across every arrival order, which is the only shape of
 * test that could have caught it before a human did.
 */

const labelArb: Arbitrary<string> = fc.oneof(
  fc.constantFrom("A", "B", "C", "D", "1080p H.264 WEB-DL", "🙂 mirror", "a", ""),
  fc.string({ maxLength: 6 })
);

/**
 * Hosts that `checkUrl` classifies as PUBLIC, so the SSRF policy is not what is
 * under test here. `url-policy.test.ts` owns that boundary; these properties are
 * about ordering and about not inventing facts, and a generator that mostly
 * produced refused URLs would make them vacuous.
 */
const playableUrlArb: Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("https://cdn.example.test", "https://media.example.test", "https://a.example"),
    fc.constantFrom("/a.mp4", "/b/c.MP4", "/live.m3u8", "/stream.m3u", "/dash.mpd", "/plain", "/q.mp4?token=1")
  )
  .map(([origin, path]) => `${origin}${path}`);

/**
 * A stream that SHOULD map, carrying every field an addon uses to advertise
 * quality it has not proven: a resolution and a codec in the display text, a
 * file size in bytes, a filename with a container extension.
 *
 * Those fields are the whole reason `observeStreamMedia` returns nothing. The
 * title is authored by the same party whose stream is being ranked, so reading
 * quality out of it lets any addon promote its own streams by renaming them.
 */
const playableStreamArb: Arbitrary<StremioStream> = fc
  .record(
    {
      url: playableUrlArb,
      name: labelArb,
      title: fc.constantFrom("2160p HEVC 10bit", "1080p h264", "SD", "AV1 4K HDR"),
      notWebReady: fc.boolean(),
      videoSize: fc.integer({ min: 0, max: 8_000_000_000 }),
      filename: fc.constantFrom("movie.mp4", "movie.mkv", "movie.webm")
    },
    { noNullPrototype: true }
  )
  .map(
    ({ url, name, title, notWebReady, videoSize, filename }): StremioStream => ({
      url,
      name,
      title,
      behaviorHints: { notWebReady, videoSize, filename }
    })
  );

/** Streams the adapter must refuse, one per refusal path it publishes. */
const refusedStreamArb: Arbitrary<StremioStream> = fc.oneof(
  fc.constant<StremioStream>({ infoHash: "c9e15763f722f23e98a29decdfae341b98d53056" }),
  fc.constant<StremioStream>({ infoHash: "c9e15763f722f23e98a29decdfae341b98d53056", fileIdx: 0 }),
  fc.constant<StremioStream>({ sources: ["tracker:udp://tracker.example.test:80"] }),
  fc.constant<StremioStream>({ url: "magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056" }),
  fc.constant<StremioStream>({ ytId: "dQw4w9WgXcQ" }),
  fc.constant<StremioStream>({ externalUrl: "https://example.test/watch" }),
  fc.constant<StremioStream>({}),
  fc.constant<StremioStream>({ url: "   " }),
  fc.constant<StremioStream>({ url: "https://cdn.example.test/a.mp4", behaviorHints: { proxyHeaders: {} } }),
  fc.constant<StremioStream>({ url: "http://cdn.example.test/a.mp4" }),
  fc.constant<StremioStream>({ url: "https://10.0.0.5/a.mp4" }),
  fc.constant<StremioStream>({ url: "https://user:pass@cdn.example.test/a.mp4" }),
  fc.constant<StremioStream>({ url: "not a url at all" })
);

/**
 * Mostly-playable responses, with refusals mixed in.
 *
 * `playableStreamArb` is listed three times rather than weighted, so the bias is
 * expressed with the smallest possible API surface. The bias itself matters: a
 * response that is mostly refusals maps nothing, and a batch-ordering property
 * over an empty `mapped` list proves nothing about ordering.
 */
const anyStreamArb: Arbitrary<StremioStream> = fc.oneof(
  playableStreamArb,
  playableStreamArb,
  playableStreamArb,
  refusedStreamArb
);

function contextArbWith(rights: Arbitrary<ContentRights>): Arbitrary<StreamMappingContext> {
  return fc.record(
    {
      sourceId: fc.constantFrom("src-a", "src-b", "local"),
      rights,
      allowLoopback: fc.boolean(),
      localDeployment: fc.boolean(),
      acceptNotWebReady: fc.boolean(),
      observedLatencyMs: fc.integer({ min: 0, max: 5_000 }),
      healthScore: healthScoreArb
    },
    { noNullPrototype: true }
  );
}

const contextArb = contextArbWith(contentRightsArb);
const unvettedContextArb = contextArbWith(unvettedRightsArb);

/** `compareRejected` re-stated from the PUBLISHED fields of a rejection. */
function compareRejectedSpec(a: RejectedStream, b: RejectedStream): number {
  const byRef = compareCodePoint(a.ref, b.ref);
  if (byRef !== 0) return byRef;
  const byReason = compareCodePoint(a.reason, b.reason);
  if (byReason !== 0) return byReason;
  return compareCodePoint(a.detail, b.detail);
}

describe("the WHOLE batch is invariant under arrival order", () => {
  it("produces an identical StreamMappingBatch for any permutation of the response", () => {
    fc.assert(
      fc.property(
        fc.array(anyStreamArb, { maxLength: 6 }),
        contextArb,
        permutationKeysArb,
        (streams, context, keys) => {
          expect(mapStremioStreams(permute(streams, keys), context)).toEqual(
            mapStremioStreams(streams, context)
          );
        }
      )
    );
  });

  it("produces an identical StreamMappingBatch for the reversed response", () => {
    fc.assert(
      fc.property(fc.array(anyStreamArb, { maxLength: 6 }), contextArb, (streams, context) => {
        expect(mapStremioStreams([...streams].reverse(), context)).toEqual(
          mapStremioStreams(streams, context)
        );
      })
    );
  });
});

describe("the batch is stable across repeats", () => {
  /*
   * Not implied by the permutation properties above, which fix the relation
   * between two calls made inside one test body and say nothing about ambient
   * state that only shows up on a later call.
   *
   * This mapper has a specific reason to care. Deduplication is built on a `Map`
   * whose iteration order is arrival order, and the file's own comment says that
   * order "does not survive into the result" because every group is sorted before
   * anything is read off it. A grouping structure that outlived one call -- a
   * cache of seen candidate ids, say -- would make the second batch differ from
   * the first while every permutation property still passed.
   *
   * There is no fixed-point property here, unlike the media-engine suites: the
   * output of this function is candidates, not streams, so its published order
   * cannot be fed back into it.
   */
  it("produces the identical StreamMappingBatch however many times it is called", () => {
    fc.assert(
      fc.property(fc.array(anyStreamArb, { maxLength: 6 }), contextArb, (streams, context) => {
        const first = mapStremioStreams(streams, context);
        expect(mapStremioStreams(streams, context)).toEqual(first);
        expect(mapStremioStreams(streams, context)).toEqual(first);
      })
    );
  });
});

describe("duplicate collapse is a function of the SET, not of the arrival order", () => {
  it("survives 0 to 5 duplicates identically in every order", () => {
    /*
     * Every copy points at the same URL, so every copy hashes to the same
     * candidate id, so all of them land in one group. What varies between copies
     * is precisely what the old fold leaked: the display label and the
     * web-readiness flag, which decide the survivor and are quoted in the
     * rejection wording.
     *
     * `acceptNotWebReady` is forced on so that a `notWebReady` copy is refused by
     * nothing and reaches the grouping. With it off, half the group would be
     * refused earlier and the three-way tie would stop being generated.
     */
    fc.assert(
      fc.property(
        playableUrlArb,
        fc.array(fc.record({ name: labelArb, notWebReady: fc.boolean() }, { noNullPrototype: true }), {
          minLength: 0,
          maxLength: 5
        }),
        contextArb,
        permutationKeysArb,
        (url, copies, context, keys) => {
          const acceptingContext: StreamMappingContext = { ...context, acceptNotWebReady: true };
          const streams: StremioStream[] = copies.map(
            ({ name, notWebReady }): StremioStream => ({ url, name, behaviorHints: { notWebReady } })
          );

          const canonical = mapStremioStreams(streams, acceptingContext);
          const permuted = mapStremioStreams(permute(streams, keys), acceptingContext);
          const reversed = mapStremioStreams([...streams].reverse(), acceptingContext);

          // The whole batch: the survivor AND the wording of every rejection.
          expect(permuted).toEqual(canonical);
          expect(reversed).toEqual(canonical);

          expect(canonical.mapped).toHaveLength(copies.length === 0 ? 0 : 1);
          expect(canonical.rejected).toHaveLength(Math.max(copies.length - 1, 0));
          for (const rejection of canonical.rejected) {
            expect(rejection.reason).toBe("duplicate_stream_url");
          }
        }
      )
    );
  });

  it("emits each candidate id at most once, in strict code-point order", () => {
    fc.assert(
      fc.property(fc.array(anyStreamArb, { maxLength: 6 }), contextArb, (streams, context) => {
        const { mapped } = mapStremioStreams(streams, context);
        for (let index = 1; index < mapped.length; index++) {
          const previous = defined(mapped[index - 1], "previous mapped stream");
          const current = defined(mapped[index], "current mapped stream");
          // Strict, because deduplication makes the ids unique: a tie here would
          // mean two survivors of one group.
          expect(compareCodePoint(previous.candidate.id, current.candidate.id)).toBeLessThan(0);
        }
      })
    );
  });

  it("orders rejections totally: a remaining tie means the entries are equal", () => {
    fc.assert(
      fc.property(fc.array(anyStreamArb, { maxLength: 6 }), contextArb, (streams, context) => {
        const { rejected } = mapStremioStreams(streams, context);
        for (let index = 1; index < rejected.length; index++) {
          const previous = defined(rejected[index - 1], "previous rejection");
          const current = defined(rejected[index], "current rejection");
          const order = compareRejectedSpec(previous, current);
          expect(order).toBeLessThanOrEqual(0);
          // The whole value of the comparator is that a tie MEANS equality. An
          // exception to that rule is how the property stops being checkable.
          if (order === 0) expect(previous).toEqual(current);
        }
      })
    );
  });
});

describe("the adapter never invents a media fact", () => {
  it("emits all four facts as null however loudly the addon advertises", () => {
    fc.assert(
      fc.property(fc.array(playableStreamArb, { maxLength: 4 }), contextArb, (streams, context) => {
        const { mapped } = mapStremioStreams(streams, context);
        for (const entry of mapped) {
          const candidate: StreamCandidate = entry.candidate;
          expect(candidate.videoCodec).toBeNull();
          expect(candidate.audioCodec).toBeNull();
          expect(candidate.height).toBeNull();
          expect(candidate.bitrateKbps).toBeNull();

          // The trail is read off the finished candidate with the contract's own
          // helper, never assembled here, so an adapter trail cannot contradict
          // the playback trail beside it.
          expect([...entry.unknownFacts]).toEqual(unknownMediaFacts(candidate));
          expect([...entry.unknownFacts]).toEqual([...MEDIA_FACTS]);
        }
      })
    );
  });

  it("observes nothing from a stream object, whatever it contains", () => {
    fc.assert(
      fc.property(anyStreamArb, (stream) => {
        expect(observeStreamMedia(stream)).toEqual({});
      })
    );
  });

  it("treats a null observation as unknown, not as a stated value", () => {
    /*
     * The types are the real guarantee, but observations are the one place a
     * value can arrive from outside TypeScript's view — a future probe parsing a
     * manifest, a JavaScript caller, a JSON fixture. A boundary that only checks
     * `=== undefined` treats `null` as measured, and that WAS the defect. The
     * casts below are how a property reaches the branch a type forbids.
     */
    const observation = <Value>(valueArb: Arbitrary<Value>): Arbitrary<Value | undefined> =>
      fc.oneof(
        valueArb,
        fc.constant(undefined),
        fc.constant(null as unknown as Value)
      ) as Arbitrary<Value | undefined>;

    fc.assert(
      fc.property(
        fc.record(
          {
            videoCodec: observation<VideoCodec>(videoCodecArb),
            audioCodec: observation<AudioCodec>(audioCodecArb),
            height: observation<number>(fc.integer({ min: 1, max: 4320 })),
            bitrateKbps: observation<number>(fc.integer({ min: 1, max: 40_000 }))
          },
          { noNullPrototype: true }
        ),
        (observed: ObservedMedia) => {
          const resolved = resolveStreamMedia(observed);
          for (const fact of MEDIA_FACTS) {
            const raw: unknown = observed[fact];
            expect(resolved[fact]).toBe(raw === undefined || raw === null ? null : raw);
          }
        }
      )
    );
  });
});

describe("the rights boundary is the operator's value and only the operator's value", () => {
  it("maps nothing at all when the source's rights are outside the allowlist", () => {
    fc.assert(
      fc.property(fc.array(playableStreamArb, { maxLength: 4 }), unvettedContextArb, (streams, context) => {
        const playable = (PLAYABLE_CONTENT_RIGHTS as readonly string[]).includes(context.rights);
        const batch = mapStremioStreams(streams, context);

        if (!playable) {
          expect(batch.mapped).toEqual([]);
          expect(batch.rejected).toHaveLength(streams.length);
          for (const rejection of batch.rejected) expect(rejection.reason).toBe("rights_not_playable");
          return;
        }

        // And when they are playable, the value is COPIED — never derived from
        // the stream, never corrected.
        for (const entry of batch.mapped) {
          expect(entry.candidate.rights).toBe(context.rights);
          expect(entry.candidate.providerId).toBe(context.sourceId);
          expect(entry.candidate.id.startsWith(`${context.sourceId}:`)).toBe(true);
        }
      })
    );
  });

  it("refuses a candidate its own contract would reject rather than publishing it", () => {
    /*
     * The provider SDK is the boundary where third-party data becomes internal
     * data, and a boundary that only checks its INPUT and trusts its own OUTPUT
     * is half a boundary. An out-of-range `healthScore` can only arrive from a
     * caller-supplied context, which the type system does not constrain to
     * [0, 1] — so this is the one property that exercises the final
     * `streamCandidateSchema.safeParse`.
     */
    fc.assert(
      fc.property(
        playableStreamArb,
        contextArb,
        fc.constantFrom(-0.5, 1.5, 42, Number.NaN),
        (stream, context, brokenHealth) => {
          const batch = mapStremioStreams([{ ...stream, behaviorHints: { notWebReady: false } }], {
            ...context,
            acceptNotWebReady: true,
            healthScore: brokenHealth
          });

          expect(batch.mapped).toEqual([]);
          expect(batch.rejected).toHaveLength(1);
          expect(defined(batch.rejected[0], "rejection").reason).toBe("candidate_failed_contract");
        }
      )
    );
  });
});

describe("protocol comes from the URL path and from nothing else", () => {
  it("ignores the query string and the path's case", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/a.mp4", "/live.m3u8", "/stream.m3u", "/dash.mpd", "/plain", "/x.m3u8.txt"),
        fc.constantFrom("", "?token=abc", "?a=1&b=2", "#fragment"),
        (path, suffix) => {
          const base = new URL(`https://cdn.example.test${path}`);
          expect(deriveProtocol(new URL(`https://cdn.example.test${path}${suffix}`))).toBe(
            deriveProtocol(base)
          );
          // A signed URL is still HLS, and an addon shouting its extension in
          // capitals has not changed what the file is.
          expect(deriveProtocol(new URL(`https://cdn.example.test${path.toUpperCase()}`))).toBe(
            deriveProtocol(base)
          );
        }
      )
    );
  });

  it("reads adaptivity as a fact and never as a guess", () => {
    fc.assert(
      fc.property(fc.constantFrom("/a.mp4", "/live.m3u8", "/stream.m3u", "/dash.mpd", "/plain"), (path) => {
        const protocol = deriveProtocol(new URL(`https://cdn.example.test${path}`));
        const lower = path.toLowerCase();
        const expected =
          lower.endsWith(".m3u8") || lower.endsWith(".m3u") ? "hls" : lower.endsWith(".mpd") ? "dash" : "https";
        // Anything unrecognised is progressive `https`, which is the PESSIMISTIC
        // reading: a misread costs the candidate rank instead of promising an
        // adaptivity it does not have.
        expect(protocol).toBe(expected);
      })
    );
  });

  it("keys a candidate by what it IS, so the same stream is the same candidate", () => {
    fc.assert(
      fc.property(playableUrlArb, playableUrlArb, (left, right) => {
        expect(stableStreamKey(left)).toBe(stableStreamKey(left));
        expect(stableStreamKey(left)).toMatch(/^[0-9a-f]{8}$/);
        if (left !== right && stableStreamKey(left) === stableStreamKey(right)) {
          // A collision merges two candidates within one source, which is the
          // same outcome as the deduplication that follows anyway. Recorded, not
          // asserted away.
          expect(stableStreamKey(right)).toMatch(/^[0-9a-f]{8}$/);
        }
      })
    );
  });
});

describe("observed health credits nothing it has not seen", () => {
  it("sits exactly on the health floor with no observations", () => {
    expect(observedHealthScore(0, 0)).toBe(0.5);
  });

  it("stays strictly inside (0, 1) and moves monotonically with the evidence", () => {
    /*
     * Bounded at 500 observations, and the bound is a FINDING rather than
     * convenience: the score is rounded to four decimal places, so around ten
     * thousand consecutive failures `(1)/(n+2)` rounds to exactly 0 and the
     * documented "never permanently condemned" property stops holding. Reported
     * with this suite; not fixed here.
     */
    fc.assert(
      fc.property(fc.nat({ max: 500 }), fc.nat({ max: 500 }), (successes, failures) => {
        const health = observedHealthScore(successes, failures);
        expect(health).toBeGreaterThan(0);
        expect(health).toBeLessThan(1);
        expect(observedHealthScore(successes + 1, failures)).toBeGreaterThanOrEqual(health);
        expect(observedHealthScore(successes, failures + 1)).toBeLessThanOrEqual(health);
      })
    );
  });

  it("ignores negative and fractional counts rather than trusting them", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        (successes, failures) => {
          const clamped = observedHealthScore(Math.max(0, successes), Math.max(0, failures));
          expect(observedHealthScore(successes, failures)).toBe(clamped);
          expect(observedHealthScore(successes + 0.7, failures + 0.7)).toBe(clamped);
        }
      )
    );
  });
});
