import fc, { type Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import { audioTrackSchema } from "./domains/audio";
import { PLAYBACK_FAILURE_KINDS, playbackFailureKindSchema } from "./domains/failover";
import {
  MAX_STREAM_CANDIDATE_ID_CHARS,
  MAX_STREAM_CANDIDATE_JSON_BYTES,
  MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS,
  resolvedStreamCandidateSchema,
  streamCandidateSchema,
  unknownMediaFacts,
  type ResolvedStreamCandidate,
  type StreamCandidate
} from "./domains/playback";
import { subtitleTrackSchema } from "./domains/subtitles";
import { audioCodecSchema, videoCodecSchema } from "./shared/codecs";
import {
  contentProtectionSchema,
  describeContentProtection,
  KEY_SYSTEMS,
  PROTECTION_UNKNOWN_REASONS,
  protectionKeySystem,
  requiresContentDecryptionModule,
  type ContentProtection
} from "./shared/drm";
import { MEDIA_FACTS, type MediaFact } from "./shared/media-facts";
import { contentRightsSchema, PLAYABLE_CONTENT_RIGHTS } from "./shared/rights";
import {
  audioCodecArb,
  audioTrackArb,
  contentRightsArb,
  languageTagArb,
  mediaFactsArb,
  nonVocabularyStringArb,
  permutationKeysArb,
  permute,
  protocolArb,
  streamCandidateArb,
  subtitleTrackArb,
  videoCodecArb
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

/* -------------------------------------------------------------------------
 * Content protection (PL-0902)
 *
 * THE GENERATORS BELOW ARE LOCAL, AND THAT IS A CONSTRAINT RATHER THAN A STYLE
 * CHOICE. `src/testing/arbitraries.ts` is PL-0206's declared write surface and
 * PL-0206 is in REVIEW, so PL-0902 may read that module but must not add to it.
 * `contentProtectionArb` and `resolvedStreamCandidateArb` therefore live here,
 * built by composing the shared `streamCandidateArb` rather than by restating
 * it -- so the candidate half of every property below is still generated by the
 * one generator the whole repository uses, and only the new field is local.
 *
 * FOLLOW-UP, stated rather than silently left: once PL-0206 lands, these two
 * belong in `testing/arbitraries.ts` beside `streamCandidateArb`, because
 * `@liberty/media-engine` and `@liberty/provider-sdk` will want the same
 * generator and a second copy of it there is how two suites end up disagreeing
 * about what a valid protected candidate looks like.
 * ---------------------------------------------------------------------- */

const keySystemArb = fc.constantFrom(...KEY_SYSTEMS);
const protectionUnknownReasonArb = fc.constantFrom(...PROTECTION_UNKNOWN_REASONS);

/** Shapes a real licence endpoint takes, including one carrying a token. */
const licenseUrlArb = fc
  .record(
    {
      host: fc.constantFrom("licence.example", "drm.example.net", "lic.cdn.example"),
      path: fc.constantFrom("/acquire", "/wv/license", "/playready/rightsmanager.asmx"),
      token: fc.option(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }).map((value) => value.toString(16)),
        { nil: null }
      )
    },
    { noNullPrototype: true }
  )
  .map(({ host, path, token }) => (token === null ? `https://${host}${path}` : `https://${host}${path}?t=${token}`));

const clearProtectionArb = fc.constant({ state: "clear" } as const);

const unknownProtectionArb = protectionUnknownReasonArb.map(
  (why) => ({ state: "unknown", why }) as ContentProtection
);

const protectedProtectionArb = fc
  .record(
    { keySystem: keySystemArb, licenseUrl: fc.option(licenseUrlArb, { nil: null }) },
    { noNullPrototype: true }
  )
  .map(({ keySystem, licenseUrl }) => ({ state: "protected", keySystem, licenseUrl }) as ContentProtection);

/** All three states, with `clear` no more likely than the two that need a CDM. */
const contentProtectionArb: fc.Arbitrary<ContentProtection> = fc.oneof(
  clearProtectionArb,
  unknownProtectionArb,
  protectedProtectionArb
);

const resolvedStreamCandidateArb: fc.Arbitrary<ResolvedStreamCandidate> = fc
  .record({ candidate: streamCandidateArb, protection: contentProtectionArb }, { noNullPrototype: true })
  .map(({ candidate, protection }) => ({ ...candidate, protection }));

describe("the local protection generators produce contract-valid values", () => {
  it("every generated resolved candidate parses, unchanged", () => {
    // The same meta-property the file opens with, for the generator this task
    // had to build locally. Without it every property below would be a test of
    // `safeParse` rather than a statement about the contract.
    fc.assert(
      fc.property(resolvedStreamCandidateArb, (candidate) => {
        const parsed = resolvedStreamCandidateSchema.safeParse(candidate);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data).toEqual(candidate);
      })
    );
  });
});

describe("an unstated protection is refused, never defaulted", () => {
  it("rejects an OMITTED protection for every candidate and every state", () => {
    /*
     * The acceptance criterion over generated input rather than over the one
     * object somebody wrote by hand. A producer that predates PL-0902 emits
     * exactly this, and the only safe answer is a parse failure: a `.default()`
     * here would turn every such producer into a claim that its streams are
     * unencrypted, which is the reading `docs/DESKTOP_PLAYBACK.md` §4 names as
     * the route to a product-invariant-2 incident.
     */
    fc.assert(
      fc.property(resolvedStreamCandidateArb, (candidate) => {
        const withoutProtection: Record<string, unknown> = { ...candidate };
        delete withoutProtection["protection"];
        expect(resolvedStreamCandidateSchema.safeParse(withoutProtection).success).toBe(false);
      })
    );
  });

  it("rejects every scalar spelling a boolean flag would have arrived as", () => {
    fc.assert(
      fc.property(
        resolvedStreamCandidateArb,
        fc.oneof(
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.string({ maxLength: 16 })
        ),
        (candidate, notADescriptor) => {
          expect(
            resolvedStreamCandidateSchema.safeParse({ ...candidate, protection: notADescriptor }).success
          ).toBe(false);
        }
      )
    );
  });

  it("rejects every state token outside the union, however plausible", () => {
    fc.assert(
      fc.property(nonVocabularyStringArb(["clear", "unknown", "protected"]), (state) => {
        expect(contentProtectionSchema.safeParse({ state }).success).toBe(false);
        expect(contentProtectionSchema.safeParse({ state, why: "not_inspected" }).success).toBe(false);
      })
    );
  });
});

describe("unknown never reads as clear", () => {
  it("requires a CDM for everything that is not an asserted clear", () => {
    /*
     * The safety property of the whole task, stated over the union rather than
     * over three examples. If a fourth state is ever added and this stays green
     * only because the generator does not produce it, the generator is the
     * thing that must change -- which is why the second assertion pins the
     * exemption to the EXACT value `{ state: "clear" }` rather than to a list.
     */
    fc.assert(
      fc.property(contentProtectionArb, (protection) => {
        expect(requiresContentDecryptionModule(protection)).toBe(protection.state !== "clear");
        if (!requiresContentDecryptionModule(protection)) {
          expect(protection).toEqual({ state: "clear" });
        }
      })
    );
  });

  it("names no key system for an unknown state, and never invents a likely one", () => {
    fc.assert(
      fc.property(unknownProtectionArb, (protection) => {
        expect(protectionKeySystem(protection)).toBeNull();
        expect(requiresContentDecryptionModule(protection)).toBe(true);
        // The refusal still says something a reader can act on.
        expect(describeContentProtection(protection)).toMatch(/^unknown:[a-z_]+$/);
      })
    );
  });

  it("names the system on every protected state, so a refusal is debuggable", () => {
    // Product invariant 4. `drm_required` with nothing named is not a trail.
    fc.assert(
      fc.property(protectedProtectionArb, (protection) => {
        const keySystem = protectionKeySystem(protection);
        expect(keySystem).not.toBeNull();
        expect(KEY_SYSTEMS).toContain(keySystem);
        expect(describeContentProtection(protection)).toBe(`protected:${String(keySystem)}`);
      })
    );
  });

  it("never leaks the licence endpoint into the reason trail", () => {
    fc.assert(
      fc.property(keySystemArb, licenseUrlArb, (keySystem, licenseUrl) => {
        const described = describeContentProtection({ state: "protected", keySystem, licenseUrl });
        expect(described).toBe(`protected:${keySystem}`);
        expect(described).not.toContain(licenseUrl);
      })
    );
  });
});

describe("provider spellings cannot reach the contract", () => {
  it("refuses every key-system string outside the vocabulary", () => {
    /*
     * Product invariant 3 as a parse result. `@liberty/provider-sdk` is the only
     * place a provider's own spelling may be turned into a `KeySystem`; if any
     * of these parsed, an adapter could pass its native string through and the
     * router would be matching on spellings instead of on a closed vocabulary.
     */
    fc.assert(
      fc.property(
        fc.oneof(
          nonVocabularyStringArb(KEY_SYSTEMS),
          fc.constantFrom(
            "com.widevine.alpha",
            "com.microsoft.playready",
            "com.microsoft.playready.recommendation",
            "com.apple.fps.1_0",
            "org.w3.clearkey",
            "Widevine",
            "WIDEVINE",
            "wv"
          )
        ),
        (native) => {
          expect(
            contentProtectionSchema.safeParse({ state: "protected", keySystem: native, licenseUrl: null })
              .success
          ).toBe(false);
        }
      )
    );
  });

  it("refuses an unrecognised value rather than admitting it as unknown by accident", () => {
    // An unrecognised provider spelling must be mapped -- deliberately, inside
    // the SDK -- onto `provider_value_unrecognised`. It must not become a
    // contract value on its own.
    fc.assert(
      fc.property(nonVocabularyStringArb(PROTECTION_UNKNOWN_REASONS), (why) => {
        expect(contentProtectionSchema.safeParse({ state: "unknown", why }).success).toBe(false);
      })
    );
  });

  it("refuses a licence endpoint that is not https, whatever else it is", () => {
    fc.assert(
      fc.property(
        keySystemArb,
        fc.oneof(
          fc.webUrl({ validSchemes: ["http"] }),
          fc.constantFrom(
            "file:///etc/passwd",
            "ftp://licence.example/acquire",
            "javascript:void(0)",
            "data:text/plain,x",
            "//licence.example/acquire",
            "licence.example/acquire",
            "https://user:pass@licence.example/acquire",
            ""
          )
        ),
        (keySystem, licenseUrl) => {
          expect(
            contentProtectionSchema.safeParse({ state: "protected", keySystem, licenseUrl }).success
          ).toBe(false);
        }
      )
    );
  });
});

describe("no unexpected key survives a protection descriptor", () => {
  it("refuses any extra key rather than stripping it", () => {
    /*
     * `.strict()` over generated key names, not over the three names somebody
     * thought of. zod's default is to DROP an unknown key and report success,
     * which is how `{ ..., key: "..." }` would travel through this contract
     * looking clean. Key material is the specific thing that must not do that.
     */
    const legitimate = new Set(["state", "why", "keySystem", "licenseUrl"]);

    fc.assert(
      fc.property(
        contentProtectionArb,
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((key) => !legitimate.has(key) && key !== "__proto__"),
        fc.oneof(fc.string({ maxLength: 32 }), fc.boolean(), fc.integer()),
        (protection, extraKey, extraValue) => {
          const smuggled = { ...protection, [extraKey]: extraValue };
          expect(contentProtectionSchema.safeParse(smuggled).success).toBe(false);
        }
      )
    );
  });
});

describe("the ranker's candidate is unchanged by this task", () => {
  it("still parses every generated candidate that states no protection", () => {
    fc.assert(
      fc.property(streamCandidateArb, (candidate) => {
        expect(streamCandidateSchema.safeParse(candidate).success).toBe(true);
      })
    );
  });

  it("drops protection on the way in, so the media engine cannot read a key system", () => {
    /*
     * `packages/provider-sdk/src/fixture/provider.ts` keeps the playable address
     * off `StreamCandidate` so that `@liberty/media-engine` "could not read
     * `uri` even by accident". This is the same guarantee for the key system:
     * the ranker's schema yields exactly the candidate it yielded before
     * PL-0902, byte for byte, whatever protection was attached.
     */
    fc.assert(
      fc.property(streamCandidateArb, contentProtectionArb, (candidate, protection) => {
        const parsed = streamCandidateSchema.parse({ ...candidate, protection });
        expect(parsed).toEqual(candidate);
        expect("protection" in parsed).toBe(false);
      })
    );
  });
});

/* -------------------------------------------------------------------------
 * The response budget (PL-0708 / register F11)
 * ---------------------------------------------------------------------- */

/**
 * No candidate the schema ACCEPTS can exceed the response budget.
 *
 * This is the property the example beside it is an instance of. F11 measured
 * one amplifier (a 1,000,000-character `id`); this states the invariant that
 * amplifier was an instance OF, so the next unbounded field is caught by
 * machine rather than by somebody happening to send a large string.
 *
 * WHY THE BUDGET IS PER-CANDIDATE AND NOT PER-RESPONSE, here.
 * `rankStreamCandidates` lives in `@liberty/media-engine`, which this package
 * must not import -- `packages/contracts/package.json` depends on `zod` alone
 * and `module-boundary.test.ts` governs the source graph. So the bound this
 * package can state and enforce is the one every consumer multiplies: the
 * serialized size of a single accepted candidate. The route and the engine
 * DERIVE their budget from `MAX_STREAM_CANDIDATE_JSON_BYTES` rather than
 * restating a number, which is the whole point of exporting it.
 *
 * THE MULTIPLIER, CORRECTED. F11 reports the 2x as the id appearing "in both
 * the ranked entry and the reason trail". The mechanism is slightly different
 * and the accurate version matters for sizing: `packages/media-engine/src/ranking.ts`
 * returns `{ selected, ranked, rejected }` where `selected = ranked[0] ?? null`
 * is the SAME object serialized a second time. So an ELIGIBLE candidate costs
 * 2x (`ranked[i].candidate` plus, for the winner, `selected.candidate`) and an
 * INELIGIBLE one costs 1x (`rejected[i].candidateId` only -- an id, not a
 * candidate). F11's measurement is right; 2x is the ceiling either way.
 */
describe("no candidate the schema accepts can exceed the response budget", () => {
  /*
   * A pool chosen for JSON cost, not for readability.
   *
   * `\u0000` and a lone surrogate are the worst case at 6 UTF-8 bytes per
   * UTF-16 unit once escaped; `"` and `\` cost 2; an astral character costs 2
   * per unit; ASCII costs 1. A generator of readable ids would never reach the
   * budget and this property would pass without ever testing it.
   */
  const costlyCharArb = fc.constantFrom("\u0000", "\u001f", "\ud800", '"', "\\", "\u{1f642}", "a", "é");

  /*
   * Two branches, and the second one is load-bearing.
   *
   * A uniformly-mixed generator explores the boundary but never gets near the
   * budget: fast-check biases toward short arrays and most of the pool costs 1
   * or 2 bytes per unit, so the largest ACCEPTED candidate it produced was 325
   * bytes against a 1,489-byte budget -- a property that passes without ever
   * exercising the thing it claims to bound. The second branch deliberately
   * builds strings clustered at the limit out of a single repeated character,
   * so the worst case is reached often rather than never. The non-vacuity test
   * below is what enforces that this stays true.
   */
  const costlyStringArb = (maxLength: number): Arbitrary<string> =>
    fc.oneof(
      fc.array(costlyCharArb, { minLength: 0, maxLength }).map((parts) => parts.join("")),
      fc
        .tuple(fc.integer({ min: Math.max(1, maxLength - 25), max: maxLength }), costlyCharArb)
        .map(([count, unit]) => unit.repeat(count))
    );

  /**
   * Candidates built to be EXPENSIVE, over string lengths that straddle the
   * bound so both outcomes are generated. Numbers are drawn at their costliest
   * renderings for the same reason.
   */
  const costlyCandidateArb = fc.record(
    {
      // Deliberately overshoots the bound: the property is an implication, and
      // a generator that could not produce a rejected candidate would leave the
      // bound itself untested.
      id: costlyStringArb(MAX_STREAM_CANDIDATE_ID_CHARS + 20),
      providerId: costlyStringArb(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS + 20),
      rights: contentRightsArb,
      protocol: protocolArb,
      height: fc.constantFrom(1, 1080, Number.MAX_SAFE_INTEGER),
      bitrateKbps: fc.constantFrom(1, 8100.5, 0.0000034017905570227214, 1.7976931348623157e308),
      estimatedLatencyMs: fc.constantFrom(0, 240, 0.0000034017905570227214),
      healthScore: fc.constantFrom(0, 1, 0.0000034017905570227214),
      videoCodec: fc.option(videoCodecArb, { nil: null }),
      audioCodec: fc.option(audioCodecArb, { nil: null })
    },
    { noNullPrototype: true }
  );

  it("holds for every accepted candidate, however expensive its characters", () => {
    fc.assert(
      fc.property(costlyCandidateArb, (candidate) => {
        const parsed = streamCandidateSchema.safeParse(candidate);
        if (!parsed.success) return; // the implication's antecedent is false
        expect(Buffer.byteLength(JSON.stringify(parsed.data))).toBeLessThanOrEqual(
          MAX_STREAM_CANDIDATE_JSON_BYTES
        );
      }),
      { numRuns: 2000 }
    );
  });

  /*
   * NON-VACUITY. The property above is an implication, so it would pass
   * trivially against a schema that rejected everything AND against one whose
   * bound was so wide the generator never reached it. This asserts the
   * generator actually produces both outcomes, and that at least one accepted
   * candidate lands within a factor of two of the budget -- i.e. the budget is
   * a real ceiling rather than a number nothing approaches.
   */
  it("actually generates candidates on both sides of the bound", () => {
    let accepted = 0;
    let refused = 0;
    let largestAccepted = 0;

    fc.assert(
      fc.property(costlyCandidateArb, (candidate) => {
        const parsed = streamCandidateSchema.safeParse(candidate);
        if (parsed.success) {
          accepted += 1;
          largestAccepted = Math.max(
            largestAccepted,
            Buffer.byteLength(JSON.stringify(parsed.data))
          );
        } else {
          refused += 1;
        }
      }),
      { numRuns: 2000 }
    );

    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(largestAccepted).toBeGreaterThan(MAX_STREAM_CANDIDATE_JSON_BYTES / 2);
  });

  /*
   * THE 2x CEILING, STATED OVER GENERATED INPUT.
   *
   * What a resolve response costs per candidate: the candidate itself in
   * `ranked`, plus one more copy if it is `selected`. An ineligible candidate
   * contributes only its id via `rejected[].candidateId`, which is strictly
   * smaller. So `2 * MAX_STREAM_CANDIDATE_JSON_BYTES` bounds any single
   * candidate's contribution, and a route multiplies that by its own candidate
   * cap rather than inventing a second bound.
   */
  it("bounds a single candidate's whole contribution to a decision at 2x", () => {
    fc.assert(
      fc.property(costlyCandidateArb, (candidate) => {
        const parsed = streamCandidateSchema.safeParse(candidate);
        if (!parsed.success) return;
        const rankedThenSelected = Buffer.byteLength(JSON.stringify(parsed.data)) * 2;
        const rejectedTrailOnly = Buffer.byteLength(JSON.stringify(parsed.data.id));
        expect(rejectedTrailOnly).toBeLessThanOrEqual(rankedThenSelected);
        expect(rankedThenSelected).toBeLessThanOrEqual(2 * MAX_STREAM_CANDIDATE_JSON_BYTES);
      }),
      { numRuns: 500 }
    );
  });
});

/**
 * The bound is above every id this repository's producers can mint.
 *
 * The example suite pins the specific real ids; this states the GRAMMAR those
 * producers are documented to emit and asserts the bound clears all of it. A
 * bound that rejects a legitimate upstream id is an outage, not a fix, and the
 * two shapes below are exactly the ones that would produce that outage.
 */
describe("the bound cannot refuse an id a producer can mint", () => {
  /** Everything except the two bounded fields, which each case supplies. */
  const baseCandidate = {
    rights: "public-domain",
    protocol: "hls",
    height: null,
    bitrateKbps: null,
    estimatedLatencyMs: 240,
    healthScore: 1,
    videoCodec: null,
    audioCodec: null
  } as const;

  /** `SOURCE_ID_PATTERN` / `FIXTURE_ID_PATTERN`: `/^[a-z0-9][a-z0-9._-]{0,63}$/i`. */
  const sourceIdArb: Arbitrary<string> = fc
    .tuple(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
      fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._-".split("")), {
        minLength: 0,
        maxLength: 63
      })
    )
    .map(([head, rest]) => head + rest.join(""));

  /** `catalog-ingestion/src/identity.ts:141` -- `${source}-${native}`, both normalized. */
  const normalizedSegmentArb: Arbitrary<string> = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
      minLength: 1,
      maxLength: 64
    })
    .map((parts) => parts.join(""));

  /** `stableStreamKey`: FNV-1a 32-bit, `toString(16).padStart(8, "0")`. */
  const streamKeyArb: Arbitrary<string> = fc
    .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 8, maxLength: 8 })
    .map((parts) => parts.join(""));

  it("accepts every stremio candidate id: `${sourceId}:${8 hex}`", () => {
    fc.assert(
      fc.property(sourceIdArb, streamKeyArb, (sourceId, key) => {
        const candidate = { ...baseCandidate, id: `${sourceId}:${key}`, providerId: sourceId };
        expect(streamCandidateSchema.safeParse(candidate).success).toBe(true);
      })
    );
  });

  it("accepts every fixture candidate id: `${source}-${native}-${variantKey}`", () => {
    fc.assert(
      fc.property(
        normalizedSegmentArb,
        normalizedSegmentArb,
        fc.constantFrom("progressive", "hls", "dash"),
        sourceIdArb,
        (source, native, variantKey, providerId) => {
          const candidate = {
            ...baseCandidate,
            id: `${source}-${native}-${variantKey}`,
            providerId
          };
          expect(streamCandidateSchema.safeParse(candidate).success).toBe(true);
        }
      )
    );
  });
});
