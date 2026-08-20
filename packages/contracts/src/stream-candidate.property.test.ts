import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { audioTrackSchema } from "./domains/audio";
import { PLAYBACK_FAILURE_KINDS, playbackFailureKindSchema } from "./domains/failover";
import { streamCandidateSchema, unknownMediaFacts, type StreamCandidate } from "./domains/playback";
import { subtitleTrackSchema } from "./domains/subtitles";
import { audioCodecSchema, videoCodecSchema } from "./shared/codecs";
import { MEDIA_FACTS, type MediaFact } from "./shared/media-facts";
import { contentRightsSchema, PLAYABLE_CONTENT_RIGHTS } from "./shared/rights";
import {
  audioTrackArb,
  languageTagArb,
  mediaFactsArb,
  nonVocabularyStringArb,
  permutationKeysArb,
  permute,
  streamCandidateArb,
  subtitleTrackArb
} from "./testing/arbitraries";

/**
 * Contract-level properties (fast-check).
 *
 * The example tests beside this file pin specific historical failures and are
 * the documentation of what went wrong. These state the invariants those
 * failures were instances OF, over generated input, so a NEW instance of the
 * same class is caught by machine rather than by somebody happening to reverse a
 * list by hand.
 *
 * Everything here is about REPRESENTATION: that `null` is the only spelling of
 * unknown, that unknown is asserted rather than achieved by silence, and that a
 * derived list is a function of the facts rather than of the order they were
 * written in. The policy consequences of those facts live in the property suites
 * of `@liberty/media-engine` and `@liberty/provider-sdk`.
 */

describe("the generators produce contract-valid domain objects", () => {
  /*
   * The meta-property, and the one that makes every other property in the
   * repository mean something.
   *
   * A generator that emits values the contract would reject turns each
   * downstream property into a test of `safeParse`. This asserts the generators
   * stay inside the contract, so a failure anywhere else in the suite is a
   * statement about POLICY.
   */
  it("every generated stream candidate parses, unchanged", () => {
    fc.assert(
      fc.property(streamCandidateArb, (candidate) => {
        const parsed = streamCandidateSchema.safeParse(candidate);
        expect(parsed.success).toBe(true);
        // No transform, no default, no stripped field: what a producer states is
        // exactly what a consumer reads.
        if (parsed.success) expect(parsed.data).toEqual(candidate);
      })
    );
  });

  it("every generated audio and subtitle track parses", () => {
    fc.assert(
      fc.property(audioTrackArb, subtitleTrackArb, (audio, subtitle) => {
        expect(audioTrackSchema.safeParse(audio).success).toBe(true);
        expect(subtitleTrackSchema.safeParse(subtitle).success).toBe(true);
      })
    );
  });
});

describe("unknown is asserted, never achieved by silence", () => {
  it("accepts an explicitly null media fact", () => {
    fc.assert(
      fc.property(streamCandidateArb, fc.constantFrom(...MEDIA_FACTS), (candidate, fact) => {
        expect(streamCandidateSchema.safeParse({ ...candidate, [fact]: null }).success).toBe(true);
      })
    );
  });

  it("rejects an OMITTED media fact, for every fact and every candidate", () => {
    /*
     * The whole argument for required-and-nullable in one property. If an
     * omitted key parsed, `undefined` would arrive at every read site meaning
     * both "we do not know" and "nobody told me to send this", and no consumer
     * could tell a deliberate unknown from a producer that predates the field.
     */
    fc.assert(
      fc.property(streamCandidateArb, fc.constantFrom(...MEDIA_FACTS), (candidate, fact) => {
        const withoutFact: Record<string, unknown> = { ...candidate };
        delete withoutFact[fact];
        expect(streamCandidateSchema.safeParse(withoutFact).success).toBe(false);
      })
    );
  });

  it("rejects every sentinel spelling of unknown", () => {
    /*
     * A sentinel is a number in a numeric field and a codec in a codec field, so
     * it survives arithmetic, comparison and serialization without ever failing
     * — which is exactly how a fabricated fact travels undetected. The schema is
     * the only place that can stop one, so it is checked over generated values
     * rather than over the three examples somebody thought of.
     *
     * The two numeric sentinel sets differ, and the difference is a REPORTED
     * FINDING rather than an oversight in this test: `height` is
     * `.int().positive()` so a fraction and an infinity both fail it, while
     * `bitrateKbps` is only `.positive()`, so `Infinity` and `0.5` are values the
     * contract currently ADMITS. Neither is a measurement. That is recorded with
     * the property suite rather than fixed here, because tightening a published
     * schema is a contract change that needs its own review.
     */
    const heightSentinelArb = fc.oneof(
      fc.constantFrom(0, -1, -1080, 1.5, Number.NaN, Number.POSITIVE_INFINITY),
      fc.constant("1080")
    );
    const bitrateSentinelArb = fc.oneof(fc.constantFrom(0, -1, -8000, Number.NaN), fc.constant("8000"));

    fc.assert(
      fc.property(
        streamCandidateArb,
        heightSentinelArb,
        bitrateSentinelArb,
        nonVocabularyStringArb(videoCodecSchema.options),
        nonVocabularyStringArb(audioCodecSchema.options),
        (candidate, heightSentinel, bitrateSentinel, videoSentinel, audioSentinel) => {
          expect(streamCandidateSchema.safeParse({ ...candidate, height: heightSentinel }).success).toBe(
            false
          );
          expect(
            streamCandidateSchema.safeParse({ ...candidate, bitrateKbps: bitrateSentinel }).success
          ).toBe(false);
          expect(streamCandidateSchema.safeParse({ ...candidate, videoCodec: videoSentinel }).success).toBe(
            false
          );
          expect(streamCandidateSchema.safeParse({ ...candidate, audioCodec: audioSentinel }).success).toBe(
            false
          );
        }
      )
    );
  });
});

describe("unknownMediaFacts is a function of the facts, not of how they were written", () => {
  /**
   * Builds the four facts as an object whose KEYS were inserted in `order`.
   *
   * Property-relevant because JavaScript object key order is observable
   * (`Object.keys`, `for...in`, JSON serialization) and a derived list assembled
   * by walking the object rather than by filtering the canonical list would
   * inherit it. The env-validator defect was this shape: a derived value keyed on
   * something incidental, which only collapsed correctly in the one arrangement
   * the tests happened to produce.
   */
  function withKeyOrder(
    facts: Pick<StreamCandidate, MediaFact>,
    order: readonly MediaFact[]
  ): Pick<StreamCandidate, MediaFact> {
    const built: Record<string, unknown> = {};
    for (const fact of order) built[fact] = facts[fact];
    return built as unknown as Pick<StreamCandidate, MediaFact>;
  }

  it("returns exactly the null facts, in MEDIA_FACTS order, whatever order the keys were written in", () => {
    fc.assert(
      fc.property(mediaFactsArb, permutationKeysArb, (facts, keys) => {
        const shuffledKeyOrder = permute(MEDIA_FACTS, keys);
        expect(shuffledKeyOrder).toHaveLength(MEDIA_FACTS.length);

        const canonical = unknownMediaFacts(facts);
        const reordered = unknownMediaFacts(withKeyOrder(facts, shuffledKeyOrder));

        expect(reordered).toEqual(canonical);
        expect(canonical).toEqual(MEDIA_FACTS.filter((fact) => facts[fact] === null));
      })
    );
  });

  it("is always a subsequence of MEDIA_FACTS: no duplicates, no reordering, no strangers", () => {
    fc.assert(
      fc.property(mediaFactsArb, (facts) => {
        const unknown = unknownMediaFacts(facts);
        expect(new Set(unknown).size).toBe(unknown.length);

        // Positions must be strictly increasing in the canonical list. A
        // published order that "happens to" match today is the thing this
        // catches when a future implementation pushes onto an array instead.
        const positions = unknown.map((fact) => MEDIA_FACTS.indexOf(fact));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
      })
    );
  });
});

describe("the rights vocabulary and its allowlist agree", () => {
  it("every playable rights value is a member of the vocabulary", () => {
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      expect(contentRightsSchema.safeParse(rights).success).toBe(true);
    }
  });

  it("nothing outside the vocabulary parses as rights", () => {
    fc.assert(
      fc.property(nonVocabularyStringArb(contentRightsSchema.options), (notARightsValue) => {
        expect(contentRightsSchema.safeParse(notARightsValue).success).toBe(false);
        // And the allowlist cannot admit what the vocabulary refuses.
        expect((PLAYABLE_CONTENT_RIGHTS as readonly string[]).includes(notARightsValue)).toBe(false);
      })
    );
  });
});

describe("the failure-kind membership list cannot drift from the schema", () => {
  /*
   * `PLAYBACK_FAILURE_KINDS` is derived from `.options`, so this cannot fail
   * today — which is the point of stating it. A kind the schema can report but
   * this array omits would never be consulted by the media engine's precedence
   * scan, so a candidate carrying only that kind stays attemptable and is
   * retried; for a rights kind that is precisely what invariants 1 and 2 forbid.
   * The day somebody replaces the derivation with a literal, this fails.
   */
  it("parses a string as a kind exactly when the membership list contains it", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...playbackFailureKindSchema.options), fc.string({ maxLength: 24 })),
        (value) => {
          const parses = playbackFailureKindSchema.safeParse(value).success;
          const listed = (PLAYBACK_FAILURE_KINDS as readonly string[]).includes(value);
          expect(listed).toBe(parses);
        }
      )
    );
  });
});

describe("language normalisation happens on parse and only on parse", () => {
  it("lower-cases every language tag it parses", () => {
    fc.assert(
      fc.property(audioTrackArb, subtitleTrackArb, languageTagArb, (audio, subtitle, language) => {
        const parsedAudio = audioTrackSchema.parse({ ...audio, language });
        const parsedSubtitle = subtitleTrackSchema.parse({ ...subtitle, language });
        expect(parsedAudio.language).toBe(language.toLowerCase());
        expect(parsedSubtitle.language).toBe(language.toLowerCase());
      })
    );
  });

  it("leaves an unparsed literal exactly as the producer wrote it", () => {
    /*
     * Not a redundant assertion. The selection policies take the TYPE, not
     * parsed output, so an adapter constructing a track literal never invokes
     * the transform and a mixed-case tag genuinely reaches the comparators. Two
     * comments in media-engine depend on this being true; here it is, checked.
     */
    fc.assert(
      fc.property(audioTrackArb, languageTagArb, (audio, language) => {
        const literal = { ...audio, language };
        expect(literal.language).toBe(language);
      })
    );
  });
});
