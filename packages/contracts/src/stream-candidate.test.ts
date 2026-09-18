import { describe, expect, it } from "vitest";
import {
  MAX_STREAM_CANDIDATE_ID_CHARS,
  MAX_STREAM_CANDIDATE_JSON_BYTES,
  MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS,
  playbackResolveRequestSchema,
  resolvedStreamCandidateSchema,
  streamCandidateSchema,
  unknownMediaFacts,
  type ResolvedStreamCandidate,
  type StatesContentProtection,
  type StreamCandidate
} from "./domains/playback";
import {
  contentProtectionSchema,
  describeContentProtection,
  KEY_SYSTEMS,
  PROTECTION_NOT_STATED,
  PROTECTION_UNKNOWN_REASONS,
  protectionKeySystem,
  requiresContentDecryptionModule
} from "./shared/drm";
import { MEDIA_FACTS } from "./shared/media-facts";

/**
 * Unknown media metadata (PL-0205).
 *
 * The property these tests exist to hold is that "unknown" is a state a producer
 * must ASSERT. It has to parse when stated and fail when merely omitted --
 * otherwise `null` is decoration and the real representation of unknown is
 * silence, which no consumer can distinguish from a producer that has not been
 * updated.
 */

const described = {
  id: "aurora-fall-hls-1080",
  providerId: "demo-owned-library",
  rights: "owned",
  protocol: "hls",
  height: 1080,
  bitrateKbps: 8100,
  estimatedLatencyMs: 240,
  healthScore: 0.93,
  videoCodec: "hevc",
  audioCodec: "eac3"
};

const capabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3"],
  preferredAudioLanguages: ["en"]
};

describe("streamCandidateSchema unknown media facts", () => {
  it("accepts a fully described candidate", () => {
    expect(streamCandidateSchema.safeParse(described).success).toBe(true);
  });

  it("accepts an explicit null for every fact a provider may not know", () => {
    for (const fact of MEDIA_FACTS) {
      const result = streamCandidateSchema.safeParse({ ...described, [fact]: null });
      expect(result.success).toBe(true);
    }
  });

  it("accepts a candidate that states none of them", () => {
    const result = streamCandidateSchema.safeParse({
      ...described,
      videoCodec: null,
      audioCodec: null,
      height: null,
      bitrateKbps: null
    });
    expect(result.success).toBe(true);
  });

  it("rejects an OMITTED fact, so unknown cannot be reached by silence", () => {
    // The whole reason these are `.nullable()` rather than `.optional()`. An
    // absent key would be indistinguishable from a producer that has not been
    // taught about the field, and the validator would be a hole rather than a
    // check.
    for (const fact of MEDIA_FACTS) {
      const payload: Record<string, unknown> = { ...described };
      delete payload[fact];
      expect(streamCandidateSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("rejects undefined as loudly as it rejects an omitted key", () => {
    for (const fact of MEDIA_FACTS) {
      expect(streamCandidateSchema.safeParse({ ...described, [fact]: undefined }).success).toBe(false);
    }
  });

  it("still refuses a numeric sentinel dressed up as a measurement", () => {
    // Zero is not "unknown". If it parsed, a fabricated fact would survive every
    // downstream comparison without ever failing -- which is exactly the failure
    // `null` exists to make impossible.
    expect(streamCandidateSchema.safeParse({ ...described, height: 0 }).success).toBe(false);
    expect(streamCandidateSchema.safeParse({ ...described, bitrateKbps: 0 }).success).toBe(false);
  });

  it("still refuses a codec value that is not a codec", () => {
    expect(streamCandidateSchema.safeParse({ ...described, videoCodec: "unknown" }).success).toBe(false);
    expect(streamCandidateSchema.safeParse({ ...described, audioCodec: "" }).success).toBe(false);
  });

  it("accepts a resolve request carrying unverified candidates", () => {
    const result = playbackResolveRequestSchema.safeParse({
      contentId: "aurora-fall",
      capabilities,
      candidates: [{ ...described, videoCodec: null, audioCodec: null, height: null, bitrateKbps: null }]
    });
    expect(result.success).toBe(true);
  });
});

describe("unknownMediaFacts", () => {
  it("returns nothing for a fully described candidate", () => {
    expect(unknownMediaFacts({
      videoCodec: "hevc",
      audioCodec: "eac3",
      height: 1080,
      bitrateKbps: 8100
    })).toEqual([]);
  });

  it("reports missing facts in MEDIA_FACTS order, not argument order", () => {
    // Derived by filtering the canonical list, so two subsystems can never
    // publish the same set of missing facts in two different orders.
    expect(unknownMediaFacts({
      bitrateKbps: null,
      height: null,
      audioCodec: null,
      videoCodec: null
    })).toEqual(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
  });

  it("reports only what is actually missing", () => {
    expect(unknownMediaFacts({
      videoCodec: null,
      audioCodec: "aac",
      height: 720,
      bitrateKbps: null
    })).toEqual(["videoCodec", "bitrateKbps"]);
  });
});

/* -------------------------------------------------------------------------
 * Content protection (PL-0902)
 *
 * The regressions below pin four things, and each of them is a specific way
 * this contract could be wrong rather than a restatement of the schema:
 *
 *   1. A resolved candidate that OMITS `protection` is refused. Not defaulted
 *      to clear, not parsed with `undefined`. This is the whole acceptance
 *      criterion: a producer that predates the field must fail loudly rather
 *      than assert, by silence, that its streams are unencrypted.
 *   2. UNKNOWN is a state that parses and that requires a CDM. If
 *      `requiresContentDecryptionModule` ever returns `false` for it, the mpv
 *      adapter stops refusing candidates whose encryption nobody established,
 *      and `docs/DESKTOP_PLAYBACK.md` §4 names that as the one-word mistake
 *      that produces a product-invariant-2 incident.
 *   3. A provider's own spelling of a key system does not parse. That is what
 *      keeps normalization inside `@liberty/provider-sdk` (invariant 3) instead
 *      of letting `com.widevine.alpha` reach a router that matches on strings.
 *   4. `streamCandidateSchema` -- the ranker's input -- is unchanged. Adding
 *      the field must change no existing candidate's meaning by accident.
 * ---------------------------------------------------------------------- */

const clear = { state: "clear" } as const;

const resolved = { ...described, protection: clear };

describe("resolvedStreamCandidateSchema requires a stated protection", () => {
  it("accepts a candidate that asserts it is clear", () => {
    expect(resolvedStreamCandidateSchema.safeParse(resolved).success).toBe(true);
  });

  it("REFUSES a candidate that omits the field, rather than defaulting it to clear", () => {
    // The acceptance criterion. A producer written before PL-0902 sends exactly
    // this object, and it must not be read as "unencrypted".
    const omitted: Record<string, unknown> = { ...resolved };
    delete omitted["protection"];
    expect(resolvedStreamCandidateSchema.safeParse(omitted).success).toBe(false);
  });

  it("refuses undefined and null as loudly as it refuses an omitted key", () => {
    // `null` is the spelling of unknown for a MEDIA FACT and deliberately is not
    // one here: a reader's reflex for a null DRM field is "there is no DRM".
    expect(resolvedStreamCandidateSchema.safeParse({ ...resolved, protection: undefined }).success).toBe(
      false
    );
    expect(resolvedStreamCandidateSchema.safeParse({ ...resolved, protection: null }).success).toBe(false);
  });

  it("refuses the boolean and the bare string it replaces", () => {
    for (const shorthand of [true, false, "drm", "widevine", "none", 1, 0]) {
      expect(resolvedStreamCandidateSchema.safeParse({ ...resolved, protection: shorthand }).success).toBe(
        false
      );
    }
    // The shape an `isDrm` flag would have arrived as.
    expect(
      resolvedStreamCandidateSchema.safeParse({ ...resolved, protection: { isDrm: true } }).success
    ).toBe(false);
  });

  it("still enforces every media-fact rule it inherited", () => {
    // `.extend()` must not have produced a second, looser candidate.
    const withoutHeight: Record<string, unknown> = { ...resolved };
    delete withoutHeight["height"];
    expect(resolvedStreamCandidateSchema.safeParse(withoutHeight).success).toBe(false);
    expect(resolvedStreamCandidateSchema.safeParse({ ...resolved, height: 0 }).success).toBe(false);
    expect(resolvedStreamCandidateSchema.safeParse({ ...resolved, videoCodec: null }).success).toBe(true);
  });
});

describe("contentProtectionSchema states three things, and unknown is one of them", () => {
  it("accepts an asserted clear state", () => {
    expect(contentProtectionSchema.safeParse(clear).success).toBe(true);
  });

  it("accepts every unknown reason, and requires one", () => {
    for (const why of PROTECTION_UNKNOWN_REASONS) {
      expect(contentProtectionSchema.safeParse({ state: "unknown", why }).success).toBe(true);
    }
    // A bare `unknown` says nothing a reader can act on, so it does not parse.
    expect(contentProtectionSchema.safeParse({ state: "unknown" }).success).toBe(false);
    expect(contentProtectionSchema.safeParse({ state: "unknown", why: "because" }).success).toBe(false);
  });

  it("accepts every key system, with and without a licence endpoint", () => {
    for (const keySystem of KEY_SYSTEMS) {
      expect(
        contentProtectionSchema.safeParse({
          state: "protected",
          keySystem,
          licenseUrl: "https://licence.example/acquire"
        }).success
      ).toBe(true);
      expect(
        contentProtectionSchema.safeParse({ state: "protected", keySystem, licenseUrl: null }).success
      ).toBe(true);
    }
  });

  it("requires the key system, and requires licenseUrl to be stated even when it is null", () => {
    expect(contentProtectionSchema.safeParse({ state: "protected", licenseUrl: null }).success).toBe(false);
    expect(contentProtectionSchema.safeParse({ state: "protected", keySystem: "widevine" }).success).toBe(
      false
    );
  });

  it("refuses a provider's own spelling of a key system", () => {
    // Invariant 3 in a parse result. If any of these parsed, a provider adapter
    // could pass its native string straight through and the router would be
    // matching on spellings instead of on a vocabulary.
    for (const native of [
      "com.widevine.alpha",
      "com.microsoft.playready",
      "com.apple.fps.1_0",
      "org.w3.clearkey",
      "Widevine",
      "WV",
      "drm"
    ]) {
      expect(
        contentProtectionSchema.safeParse({ state: "protected", keySystem: native, licenseUrl: null })
          .success
      ).toBe(false);
    }
  });

  it("refuses an unrecognised state instead of treating it as clear", () => {
    for (const state of ["none", "encrypted", "drm", "", "CLEAR"]) {
      expect(contentProtectionSchema.safeParse({ state }).success).toBe(false);
    }
  });

  it("refuses key material rather than silently stripping it", () => {
    // `.strict()` on every variant. zod's default would drop these keys and
    // report a clean parse, which is how key material travels undetected.
    for (const smuggled of [
      { state: "protected", keySystem: "widevine", licenseUrl: null, key: "AAAA" },
      { state: "protected", keySystem: "widevine", licenseUrl: null, keyId: "AAAA" },
      { state: "protected", keySystem: "widevine", licenseUrl: null, pssh: "AAAA" },
      { state: "clear", keySystem: "widevine" },
      { state: "unknown", why: "not_inspected", licenseUrl: "https://licence.example/acquire" }
    ]) {
      expect(contentProtectionSchema.safeParse(smuggled).success).toBe(false);
    }
  });

  it("holds a licence endpoint to the standard a media URL is held to", () => {
    const acquire = (licenseUrl: unknown) =>
      contentProtectionSchema.safeParse({ state: "protected", keySystem: "widevine", licenseUrl }).success;

    expect(acquire("https://licence.example/acquire")).toBe(true);
    expect(acquire("http://licence.example/acquire")).toBe(false);
    expect(acquire("https://user:pass@licence.example/acquire")).toBe(false);
    expect(acquire("file:///etc/passwd")).toBe(false);
    expect(acquire("licence.example/acquire")).toBe(false);
    expect(acquire("")).toBe(false);
    expect(acquire(undefined)).toBe(false);
  });

  it("names the unstated default as unknown, never as clear", () => {
    expect(PROTECTION_NOT_STATED.state).toBe("unknown");
    expect(contentProtectionSchema.safeParse(PROTECTION_NOT_STATED).success).toBe(true);
  });
});

describe("routing can be decided, and explained, from the contract alone", () => {
  it("requires a CDM for protected AND for unknown, and only exempts an asserted clear", () => {
    expect(requiresContentDecryptionModule({ state: "clear" })).toBe(false);
    for (const why of PROTECTION_UNKNOWN_REASONS) {
      expect(requiresContentDecryptionModule({ state: "unknown", why })).toBe(true);
    }
    for (const keySystem of KEY_SYSTEMS) {
      expect(requiresContentDecryptionModule({ state: "protected", keySystem, licenseUrl: null })).toBe(
        true
      );
    }
  });

  it("names the system in a refusal, and names the reason when there is no system", () => {
    // Invariant 4: `drm_required` with nothing named is not a debuggable trail.
    expect(describeContentProtection({ state: "protected", keySystem: "playready", licenseUrl: null })).toBe(
      "protected:playready"
    );
    expect(describeContentProtection({ state: "unknown", why: "provider_value_unrecognised" })).toBe(
      "unknown:provider_value_unrecognised"
    );
    expect(describeContentProtection({ state: "clear" })).toBe("clear");
    expect(protectionKeySystem({ state: "protected", keySystem: "fairplay", licenseUrl: null })).toBe(
      "fairplay"
    );
    expect(protectionKeySystem({ state: "unknown", why: "not_inspected" })).toBeNull();
    expect(protectionKeySystem({ state: "clear" })).toBeNull();
  });

  it("never puts the licence endpoint in the reason trail", () => {
    // A trail is logged; a licence endpoint can carry a per-session token.
    const trail = describeContentProtection({
      state: "protected",
      keySystem: "widevine",
      licenseUrl: "https://licence.example/acquire?token=SECRET"
    });
    expect(trail).toBe("protected:widevine");
    expect(trail).not.toContain("SECRET");
    expect(trail).not.toContain("licence.example");
  });
});

describe("the ranker's candidate is unchanged", () => {
  it("still parses a candidate that states no protection at all", () => {
    // PL-0902 added a schema; it did not retag every existing producer.
    expect(streamCandidateSchema.safeParse(described).success).toBe(true);
  });

  it("does not carry protection through, so the media engine cannot read it", () => {
    // `streamCandidateSchema` strips the key. The ranker could not act on a key
    // system even by accident, which is the property `docs/DESKTOP_PLAYBACK.md`
    // §4 relies on when it says routing "does not rank".
    const parsed = streamCandidateSchema.parse(resolved);
    expect("protection" in parsed).toBe(false);
  });

  it("still accepts a resolve request built from protection-less candidates", () => {
    expect(
      playbackResolveRequestSchema.safeParse({
        contentId: "aurora-fall",
        capabilities,
        candidates: [described]
      }).success
    ).toBe(true);
  });
});

describe("the session's obligation is a compile error, not a doc note", () => {
  /*
   * `StatesContentProtection` is what PL-0501 pins its wire candidate against.
   * These two declarations are the test: the first stops compiling if
   * `protection` is dropped from the resolved candidate, and the second proves
   * the guard actually discriminates rather than accepting everything.
   */
  const resolvedStates: StatesContentProtection<ResolvedStreamCandidate> = true;

  type RankerCandidateGuard = StatesContentProtection<StreamCandidate>;
  const rankerCandidateIsNotGuarded: [RankerCandidateGuard] extends [never] ? true : false = true;

  it("accepts the resolved candidate and rejects the ranker's candidate", () => {
    expect(resolvedStates).toBe(true);
    expect(rankerCandidateIsNotGuarded).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Length bounds on the candidate's string fields (PL-0708 / register F11)
 * ---------------------------------------------------------------------- */

/**
 * The measurement this task exists to answer, pinned as a test.
 *
 * `docs/SECURITY_REVIEW_PROVIDER_URL.md` F11 measured a candidate carrying a
 * 1,000,000-character `id` producing a 2,002,555-byte response. Before this
 * task `streamCandidateSchema.id` was `z.string().min(1)`, so the contract
 * ACCEPTED that candidate and every consumer inherited it.
 *
 * These assert the three things a bound has to get right, in the order they can
 * go wrong: it refuses the amplifier, its refusal does not itself amplify, and
 * it does not refuse anything a real producer can mint.
 */
describe("a candidate cannot amplify a response (F11)", () => {
  const F11_ID_CHARS = 1_000_000;

  it("refuses the 1,000,000-character id that F11 measured", () => {
    const result = streamCandidateSchema.safeParse({ ...described, id: "a".repeat(F11_ID_CHARS) });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((candidateIssue) => candidateIssue.path[0] === "id");
    expect(issue?.code).toBe("too_big");
  });

  it("refuses an unbounded providerId on the same grounds", () => {
    const result = streamCandidateSchema.safeParse({
      ...described,
      providerId: "a".repeat(F11_ID_CHARS)
    });
    expect(result.success).toBe(false);
  });

  /*
   * THE REFUSAL MUST NOT BE THE AMPLIFIER.
   *
   * `apps/web/src/app/api/v1/playback/resolve/handler.ts` returns
   * `{ error: "invalid_request", issues: parsed.error.issues }` verbatim on a
   * parse failure, so a validator that echoed the rejected value would turn the
   * bound into the very reflection F11 filed. Zod's `too_big` issue carries the
   * LIMIT and the path, never the received value -- asserted here rather than
   * trusted, because it is a property of a dependency this package does not own.
   *
   * Written against zod 4 (`too_big` carries `origin`/`maximum`), which is what
   * resolves here; the declared range in package.json is a separate decision.
   */
  it("does not echo the rejected value in the issue a route would return", () => {
    const payload = "a".repeat(F11_ID_CHARS);
    const result = streamCandidateSchema.safeParse({ ...described, id: payload });
    expect(result.success).toBe(false);
    if (result.success) return;

    const body = JSON.stringify({ error: "invalid_request", issues: result.error.issues });
    expect(body).not.toContain(payload);
    // F11 measured 2,002,555 bytes for this input. The refusal is three orders
    // of magnitude smaller and is a function of the LIMIT, not of the input.
    expect(Buffer.byteLength(body)).toBeLessThan(1_000);
  });
});

/**
 * A bound that rejects a legitimate upstream id is an outage, not a fix.
 *
 * Every value below is one this repository can actually mint today, so this is
 * the regression that fires if a later round tightens a bound past a producer.
 * The two id grammars are restated here deliberately: `@liberty/contracts` must
 * not depend on `@liberty/provider-sdk`, so the check is against the SHAPE those
 * producers are documented to emit rather than against an import.
 */
describe("the bounds refuse nothing a real producer can mint", () => {
  /** `packages/provider-sdk/src/fixture/provider.ts:674` -- `${contentId}-${variant.key}`. */
  const fixtureIds = [
    "aurora-fall-hls",
    "aurora-fall-dash",
    "aurora-fall-progressive",
    "big-buck-bunny-hls",
    "big-buck-bunny-dash",
    "big-buck-bunny-progressive",
    // Derived from Wikidata by `catalog-ingestion/src/identity.ts:141`:
    // `${normalize("wikidata")}-${normalize("Q83495")}` then the variant key.
    "wikidata-q83495-progressive",
    // A ten-digit QID, which Wikidata has not reached and would still fit.
    "wikidata-q1342177280-progressive"
  ];

  /** `packages/provider-sdk/src/stremio/mapping.ts:496` -- `${sourceId}:${8 hex}`. */
  const stremioIds = [
    "stremio-a:1a2b3c4d",
    "public-domain-archive:00000000",
    // A source id at the full 64 characters `SOURCE_ID_PATTERN` allows.
    `${"s".repeat(64)}:deadbeef`
  ];

  const providerIds = [
    "fixture",
    "wikidata",
    "stremio-a",
    "local-library",
    "public-domain-archive",
    // The longest `SOURCE_ID_PATTERN` / `FIXTURE_ID_PATTERN` value: 64 chars.
    `s${"o".repeat(63)}`
  ];

  it.each(fixtureIds)("accepts the fixture candidate id %s", (id) => {
    expect(streamCandidateSchema.safeParse({ ...described, id }).success).toBe(true);
  });

  it.each(stremioIds)("accepts the stremio candidate id %s", (id) => {
    expect(streamCandidateSchema.safeParse({ ...described, id }).success).toBe(true);
  });

  it.each(providerIds)("accepts the provider id %s", (providerId) => {
    expect(streamCandidateSchema.safeParse({ ...described, providerId }).success).toBe(true);
  });
});

describe("the bounds are exactly where the derivation puts them", () => {
  it("accepts an id at the limit and refuses one character more", () => {
    expect(
      streamCandidateSchema.safeParse({ ...described, id: "a".repeat(MAX_STREAM_CANDIDATE_ID_CHARS) })
        .success
    ).toBe(true);
    expect(
      streamCandidateSchema.safeParse({
        ...described,
        id: "a".repeat(MAX_STREAM_CANDIDATE_ID_CHARS + 1)
      }).success
    ).toBe(false);
  });

  it("accepts a providerId at the limit and refuses one character more", () => {
    expect(
      streamCandidateSchema.safeParse({
        ...described,
        providerId: "a".repeat(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS)
      }).success
    ).toBe(true);
    expect(
      streamCandidateSchema.safeParse({
        ...described,
        providerId: "a".repeat(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS + 1)
      }).success
    ).toBe(false);
  });

  it("still requires a non-empty id and providerId", () => {
    expect(streamCandidateSchema.safeParse({ ...described, id: "" }).success).toBe(false);
    expect(streamCandidateSchema.safeParse({ ...described, providerId: "" }).success).toBe(false);
  });

  /*
   * THE CONSTANT IS THE ARITHMETIC, NOT A GUESS ABOUT IT.
   *
   * `MAX_STREAM_CANDIDATE_JSON_BYTES` is a hand-written literal, so this
   * reconstructs the worst case it claims to describe and asserts the two agree
   * EXACTLY. A later round that widens `id` and forgets the budget fails here
   * rather than shipping a constant that no longer bounds anything.
   *
   * Worst case per field: a UTF-16 unit costs at most 6 UTF-8 bytes once
   * JSON-escaped (`\u0000`, or a lone surrogate), the longest enum member of
   * each vocabulary, `Number.MAX_SAFE_INTEGER` for the `.int()` field and the
   * longest `JSON.stringify` rendering of a finite double for the other three.
   */
  it("equals the worst case a schema-accepted candidate can serialize to", () => {
    const longestDouble = 0.0000034017905570227214; // 24 chars -- the JS maximum
    const worstCase = {
      id: "\u0000".repeat(MAX_STREAM_CANDIDATE_ID_CHARS),
      providerId: "\u0000".repeat(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS),
      rights: "public-domain",
      protocol: "https",
      height: Number.MAX_SAFE_INTEGER,
      bitrateKbps: longestDouble,
      estimatedLatencyMs: longestDouble,
      healthScore: longestDouble,
      videoCodec: "hevc",
      audioCodec: "eac3"
    };

    const parsed = streamCandidateSchema.safeParse(worstCase);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(Buffer.byteLength(JSON.stringify(parsed.data))).toBe(MAX_STREAM_CANDIDATE_JSON_BYTES);
    expect(JSON.stringify(longestDouble)).toHaveLength(24);
  });
});
