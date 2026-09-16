import { describe, expect, it } from "vitest";
import {
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
