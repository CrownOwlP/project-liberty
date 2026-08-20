import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { audioRoleSchema, type AudioTrack } from "../domains/audio";
import type { FailoverPolicy, PlaybackAttemptFailure, PlaybackFailureKind } from "../domains/failover";
import { playbackFailureKindSchema } from "../domains/failover";
import { streamCandidateSchema } from "../domains/playback";
import type { PlaybackCapabilities, StreamCandidate } from "../domains/playback";
import {
  subtitleFormatSchema,
  subtitleKindSchema,
  subtitleModeSchema,
  type SubtitlePolicy,
  type SubtitleTrack
} from "../domains/subtitles";
import { audioCodecSchema, videoCodecSchema, type AudioCodec, type VideoCodec } from "../shared/codecs";
import type { MediaFact } from "../shared/media-facts";
import { contentRightsSchema, type ContentRights } from "../shared/rights";

/* -------------------------------------------------------------------------
 * Domain arbitraries for property-based testing (PL property suite).
 *
 * WHY THIS LIVES IN `@liberty/contracts` AND NOT IN EACH TEST PACKAGE.
 *
 * A generator is a second description of a shape. Written once per package it
 * becomes three descriptions, and the moment the contract gains a field the
 * three drift apart silently — a property suite whose generators no longer
 * produce the shape under test proves nothing and reports nothing, which is
 * strictly worse than having no suite. Every value set below is therefore read
 * off the schema itself (`.options`, `.shape`) wherever the schema can state it,
 * and every exported arbitrary is annotated with the CONTRACT type, so a new
 * required field is a compile error here rather than a hole in the coverage.
 *
 * NOTHING IN THIS FILE IS PRODUCTION CODE. It is reachable only through the
 * `./testing/*` subpath export and is imported exclusively by `*.property.test.ts`
 * files. It defines no schema, so it does not widen the contract surface, and it
 * imports no domain sibling through the barrel — the module boundary this
 * package enforces applies to it like any other module.
 *
 * WHAT THE GENERATORS DELIBERATELY DO NOT DO: they do not produce garbage. A
 * generator emitting arbitrary JSON would only ever prove that `safeParse`
 * rejects nonsense, which the example tests already pin. Every value here is a
 * structurally valid domain object, so a failing property is a statement about
 * the POLICY rather than about input validation. The two exceptions are named
 * (`unvettedRightsArb`, `nonVocabularyStringArb`) and each exists to probe a
 * boundary the type system cannot express.
 * ---------------------------------------------------------------------- */

/**
 * Global fast-check settings, applied once when this module is first imported.
 *
 * SEED. Pinned by default, and that is the whole point: an unpinned property
 * suite fails on one CI run out of forty with a counterexample nobody can
 * reproduce, and a test that cannot be reproduced gets retried until it passes,
 * which converts a real defect into noise. `LIBERTY_FC_SEED` overrides it, so
 * widening the search is one environment variable rather than an edit — run the
 * suite in a nightly job with a random seed and pin any counterexample it finds
 * by copying the seed fast-check prints.
 *
 * fast-check reports `{ seed, path, endOnFailure }` on every failure, so a
 * counterexample from any run is replayable with
 * `fc.assert(prop, { seed, path })` regardless of what the default is here.
 *
 * `verbose` is on so the failure report lists the shrinking trail rather than
 * the final counterexample alone; shrinking is the reason to use a property
 * runner at all and an unreadable report wastes it.
 *
 * `numRuns` is stated rather than left to the default so that the CI cost of
 * `npm run check` is a number somebody chose. These properties are pure
 * in-memory policy calls over lists of at most `MAX_LIST_LENGTH` items, so 100
 * runs each is microseconds, not seconds.
 */
const DEFAULT_SEED = 20250819;

function configuredSeed(): number {
  const stated = process.env.LIBERTY_FC_SEED;
  if (stated === undefined || stated.trim() === "") return DEFAULT_SEED;
  const parsed = Number(stated);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SEED;
}

export const FAST_CHECK_SEED = configuredSeed();

fc.configureGlobal({
  seed: FAST_CHECK_SEED,
  numRuns: 100,
  verbose: true
});

/**
 * Upper bound on generated list lengths.
 *
 * Six rather than two or three, deliberately. The duplicate-collapse defect in
 * the Stremio mapper was invisible below THREE duplicates, because with two the
 * incumbent at rejection time is always the eventual survivor; a suite that only
 * ever generates short lists reproduces that blind spot. Six is enough for a
 * three-way tie plus context and small enough that shrinking reports something a
 * human can read.
 */
export const MAX_LIST_LENGTH = 6;

/** Narrows an indexed read under `noUncheckedIndexedAccess` without `!`. */
export function defined<Value>(value: Value | undefined, what: string): Value {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

/**
 * A permutation of `items` driven by generated keys.
 *
 * Written here rather than reached for from fast-check's shuffling helpers so
 * that the permutation is an ORDINARY generated value, which is what makes
 * shrinking useful: fast-check shrinks a `nat` towards zero, and the swap target
 * is written as `index - (key % (index + 1))` rather than the textbook
 * `key % (index + 1)` SO THAT A ZERO KEY IS A NO-OP. Under the textbook form
 * every key shrinking to zero produces `swap(index, 0)` at every step -- a
 * thoroughly scrambled list -- so the minimal counterexample fast-check reported
 * would be minimal in the KEYS and arbitrary in the resulting order. With this
 * form, zero keys are the identity, and a shrunk failure names the smallest
 * reordering that breaks the property: usually a single transposition, which is
 * the thing a human can actually read and reason about.
 *
 * Both forms are Fisher-Yates and both are uniform over permutations, so nothing
 * about coverage changes -- only the legibility of a failure. Extra keys are
 * ignored and missing keys read as zero, so the key array's length never has to
 * be tied to the list's.
 *
 * NOTE that identity IS a permutation and the invariance properties must hold
 * for it trivially; the reversal tests beside every permutation test exist
 * precisely so that the suite does not depend on the generator happening to
 * produce a non-trivial reordering.
 */
export function permute<Item>(items: readonly Item[], keys: readonly number[]): Item[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const key = keys[out.length - 1 - index] ?? 0;
    const target = index - (key % (index + 1));
    const moved = out[index] as Item;
    const displaced = out[target] as Item;
    out[index] = displaced;
    out[target] = moved;
  }
  return out;
}

/** Keys for `permute`. Long enough for any list this module generates. */
export const permutationKeysArb: Arbitrary<number[]> = fc.array(fc.nat({ max: 1_000_000 }), {
  minLength: 0,
  maxLength: MAX_LIST_LENGTH * 4
});

/* -------------------------------------------------------------------------
 * Leaf value arbitraries, read off the schemas.
 * ---------------------------------------------------------------------- */

export const videoCodecArb: Arbitrary<VideoCodec> = fc.constantFrom(...videoCodecSchema.options);
export const audioCodecArb: Arbitrary<AudioCodec> = fc.constantFrom(...audioCodecSchema.options);
export const contentRightsArb: Arbitrary<ContentRights> = fc.constantFrom(...contentRightsSchema.options);
export const playbackFailureKindArb: Arbitrary<PlaybackFailureKind> = fc.constantFrom(
  ...playbackFailureKindSchema.options
);

/**
 * The delivery protocol, read out of the candidate schema's own shape rather
 * than restated, so a fourth protocol is generated the day it is contracted.
 */
export const protocolArb: Arbitrary<StreamCandidate["protocol"]> = fc.constantFrom(
  ...streamCandidateSchema.shape.protocol.options
);

/**
 * Ids, drawn from a deliberately narrow pool.
 *
 * Short strings collide often, which is what makes the tie-break paths in every
 * comparator reachable; a wide pool would make ties astronomically rare and the
 * tie-break code would never be exercised. The non-ASCII constants are here
 * because every id comparator in this repository is documented as comparing by
 * CODE POINT rather than by `localeCompare`, and an ASCII-only generator cannot
 * tell the two apart.
 */
export const idArb: Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 4 }),
  fc.constantFrom("a", "A", "b", "B", "z", "Z", "0", "_", "é", "ß", "Ω", "🙂", "ä", "z̈")
);

export const providerIdArb: Arbitrary<string> = fc.constantFrom(
  "stremio-a",
  "stremio-b",
  "local-library",
  "archive"
);

/**
 * Language tags, mixed case on purpose.
 *
 * `audioTrackSchema.language` and `subtitleTrackSchema.language` lower-case
 * through a `.transform()`, and the selection policies take the TYPE rather than
 * parsed output — so a provider adapter constructing a track literal never runs
 * the transform and `"EN-GB"` genuinely reaches the comparator. Generating only
 * pre-normalised tags would hide every case-folding defect in `languageMatch`.
 */
export const languageTagArb: Arbitrary<string> = fc.constantFrom(
  "en",
  "en-us",
  "en-gb",
  "EN-GB",
  "fr",
  "fr-ca",
  "ja",
  "pt",
  "pt-br",
  "pt-pt",
  "PT-BR",
  "zh-hans",
  "zh-hant",
  "de",
  "es"
);

/**
 * Health, generated on a hundredth-point lattice.
 *
 * Integers scaled down rather than `fc.double`, because the property under test
 * is never about float representation: exact hundredths keep the generated value
 * inside `z.number().min(0).max(1)` without argument and keep a shrunk
 * counterexample readable as `0.42` rather than as seventeen significant digits.
 */
export const healthScoreArb: Arbitrary<number> = fc
  .integer({ min: 0, max: 100 })
  .map((hundredths) => hundredths / 100);

export const heightArb: Arbitrary<number> = fc.constantFrom(144, 240, 360, 480, 720, 1080, 1440, 2160, 4320);
export const bitrateKbpsArb: Arbitrary<number> = fc.integer({ min: 1, max: 40_000 });
export const latencyMsArb: Arbitrary<number> = fc.integer({ min: 0, max: 5_000 });

/**
 * A rights value that may be OUTSIDE the vocabulary, reached by a cast.
 *
 * The cast is the point and it is not laziness. `PLAYABLE_CONTENT_RIGHTS` and
 * media-engine's `PLAYABLE_RIGHTS` are explicit allowlists whose stated purpose
 * is that "any new rights value is non-playable until it is reviewed" — and
 * today every member of `contentRightsSchema` is on both allowlists, so with
 * only well-typed values that guarantee is VACUOUS and no test can observe it.
 * The strings below stand in for the rights value somebody adds to the enum next
 * quarter without touching the allowlist. If the allowlist ever stops being
 * consulted, these properties fail; nothing else in the suite would notice.
 */
export const unvettedRightsArb: Arbitrary<ContentRights> = fc.oneof(
  contentRightsArb,
  fc.constantFrom("unlicensed", "expired", "rights-unknown", "public_domain", "")
) as unknown as Arbitrary<ContentRights>;

/** Strings that are NOT members of `values`. For "everything else is refused". */
export function nonVocabularyStringArb(values: readonly string[]): Arbitrary<string> {
  return fc
    .oneof(fc.string({ maxLength: 12 }), fc.constantFrom("unknown", "none", "null", "0", "n/a", "UNKNOWN"))
    .filter((candidate) => !values.includes(candidate));
}

/* -------------------------------------------------------------------------
 * Stream candidates.
 * ---------------------------------------------------------------------- */

/**
 * How often a media fact comes back UNKNOWN, stated rather than defaulted.
 *
 * `fc.option`'s default `freq` is 6, i.e. nil one time in six. Left at the
 * default, all four facts are unknown together on 1 run in 1296 — so a suite of
 * 100 runs would essentially never generate the fully-unstated candidate, which
 * is the exact shape PL-0205 exists for and the one every "unknown is neither a
 * pass nor a fail" branch is reached by. `freq: 2` makes stated and unstated
 * equally likely, which is the honest weighting for a contract whose whole point
 * is that `null` is a first-class value rather than an edge case: at least one
 * unknown fact on ~94% of runs, all four on ~6%.
 */
const UNKNOWN_FACT_FREQ = 2;

/** The four media facts, each independently stated or `null` (= UNKNOWN). */
export const mediaFactsArb: Arbitrary<Pick<StreamCandidate, MediaFact>> = fc.record(
  {
    videoCodec: fc.option(videoCodecArb, { nil: null, freq: UNKNOWN_FACT_FREQ }),
    audioCodec: fc.option(audioCodecArb, { nil: null, freq: UNKNOWN_FACT_FREQ }),
    height: fc.option(heightArb, { nil: null, freq: UNKNOWN_FACT_FREQ }),
    bitrateKbps: fc.option(bitrateKbpsArb, { nil: null, freq: UNKNOWN_FACT_FREQ })
  },
  { noNullPrototype: true }
);

/**
 * A candidate that states ALL FOUR facts.
 *
 * The type is narrowed rather than left as `StreamCandidate`, so a property that
 * says "a fully-stated candidate never scores below one with facts removed" can
 * read `candidate.height` as a number instead of re-proving non-nullness it
 * already arranged.
 */
export type StatedStreamCandidate = Omit<StreamCandidate, MediaFact> & {
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  height: number;
  bitrateKbps: number;
};

export const statedMediaFactsArb: Arbitrary<Pick<StatedStreamCandidate, MediaFact>> = fc.record(
  {
    videoCodec: videoCodecArb,
    audioCodec: audioCodecArb,
    height: heightArb,
    bitrateKbps: bitrateKbpsArb
  },
  { noNullPrototype: true }
);

const candidateEnvelopeArb = fc.record(
  {
    id: idArb,
    providerId: providerIdArb,
    protocol: protocolArb,
    estimatedLatencyMs: latencyMsArb,
    healthScore: healthScoreArb
  },
  { noNullPrototype: true }
);

/**
 * `noNullPrototype: true` on every `fc.record` in this file.
 *
 * fast-check v4 generates records with a null prototype by default. Nothing in
 * the media engine reads a prototype, so this is not a correctness fix — it is a
 * REPORTING one: a null-prototype object stringifies as `{__proto__:null,...}`
 * in every counterexample, in every `toEqual` diff, and in every reason trail a
 * property prints, which triples the width of the output a human has to read to
 * find the one field that differed.
 */
function candidateFrom(
  rightsArb: Arbitrary<ContentRights>,
  factsArb: Arbitrary<Pick<StreamCandidate, MediaFact>>
): Arbitrary<StreamCandidate> {
  return fc
    .record({ envelope: candidateEnvelopeArb, rights: rightsArb, facts: factsArb }, { noNullPrototype: true })
    .map(({ envelope, rights, facts }) => ({ ...envelope, rights, ...facts }));
}

/** Contract-valid in every field, with any combination of unknown facts. */
export const streamCandidateArb: Arbitrary<StreamCandidate> = candidateFrom(contentRightsArb, mediaFactsArb);

/** Contract-valid except that `rights` may be outside the vocabulary. */
export const unvettedRightsCandidateArb: Arbitrary<StreamCandidate> = candidateFrom(
  unvettedRightsArb,
  mediaFactsArb
);

/** Every media fact stated. See `StatedStreamCandidate`. */
export const statedStreamCandidateArb: Arbitrary<StatedStreamCandidate> = fc
  .record(
    { envelope: candidateEnvelopeArb, rights: contentRightsArb, facts: statedMediaFactsArb },
    { noNullPrototype: true }
  )
  .map(({ envelope, rights, facts }) => ({ ...envelope, rights, ...facts }));

/**
 * A list of candidates with DISTINCT ids.
 *
 * Uniqueness is a domain constraint, not a convenience: a candidate id is a
 * pure function of the stream it names (`sourceId:hash(url)`), so two entries
 * sharing an id are the same candidate, and the adapter collapses them before
 * they ever reach the engine. It also matters for what these properties can
 * claim — every ordering in the engine terminates in a code-point tiebreak on
 * the id, so distinct ids are exactly the condition under which those
 * comparators are TOTAL. See `docs` in the ranking property test for what is
 * knowingly left unchecked by this choice.
 */
export function distinctByIdArb<Item extends { id: string }>(
  item: Arbitrary<Item>,
  maxLength: number = MAX_LIST_LENGTH
): Arbitrary<Item[]> {
  return fc.uniqueArray(item, { selector: (value) => value.id, minLength: 0, maxLength });
}

export const streamCandidatesArb: Arbitrary<StreamCandidate[]> = distinctByIdArb(streamCandidateArb);
export const unvettedRightsCandidatesArb: Arbitrary<StreamCandidate[]> =
  distinctByIdArb(unvettedRightsCandidateArb);

/* -------------------------------------------------------------------------
 * Capabilities and policies.
 * ---------------------------------------------------------------------- */

export const playbackCapabilitiesArb: Arbitrary<PlaybackCapabilities> = fc
  .record(
    {
      maxHeight: fc.constantFrom(480, 720, 1080, 2160, 4320),
      supportedVideoCodecs: fc.uniqueArray(videoCodecArb, {
        minLength: 1,
        maxLength: videoCodecSchema.options.length
      }),
      supportedAudioCodecs: fc.uniqueArray(audioCodecArb, {
        minLength: 1,
        maxLength: audioCodecSchema.options.length
      }),
      preferredAudioLanguages: fc.array(languageTagArb, { maxLength: 3 }),
      maxAudioChannels: fc.option(fc.constantFrom(2, 6, 8, 16), { nil: undefined })
    },
    { noNullPrototype: true }
  )
  // Spread conditionally rather than assigning `undefined`: under
  // `exactOptionalPropertyTypes` an absent `maxAudioChannels` and one present
  // holding `undefined` are different values, and the contract's own comment
  // says absent means "no channel constraint known".
  .map(({ maxAudioChannels, ...rest }) =>
    maxAudioChannels === undefined ? { ...rest } : { ...rest, maxAudioChannels }
  );

/** Capabilities that admit `candidate`, so eligibility cannot make a property vacuous. */
export function capabilitiesAdmitting(candidate: StatedStreamCandidate): Arbitrary<PlaybackCapabilities> {
  return fc
    .record(
      {
        extraHeight: fc.constantFrom(0, 360, 1080, 2160),
        extraVideoCodecs: fc.uniqueArray(videoCodecArb, { maxLength: videoCodecSchema.options.length }),
        extraAudioCodecs: fc.uniqueArray(audioCodecArb, { maxLength: audioCodecSchema.options.length }),
        preferredAudioLanguages: fc.array(languageTagArb, { maxLength: 3 })
      },
      { noNullPrototype: true }
    )
    .map(({ extraHeight, extraVideoCodecs, extraAudioCodecs, preferredAudioLanguages }) => ({
      maxHeight: candidate.height + extraHeight,
      supportedVideoCodecs: [...new Set([candidate.videoCodec, ...extraVideoCodecs])],
      supportedAudioCodecs: [...new Set([candidate.audioCodec, ...extraAudioCodecs])],
      preferredAudioLanguages
    }));
}

export const audioTrackArb: Arbitrary<AudioTrack> = fc.record(
  {
    id: idArb,
    language: languageTagArb,
    codec: audioCodecArb,
    channels: fc.constantFrom(1, 2, 6, 8),
    role: fc.constantFrom(...audioRoleSchema.options),
    isDefault: fc.boolean()
  },
  { noNullPrototype: true }
);

export const audioTracksArb: Arbitrary<AudioTrack[]> = distinctByIdArb(audioTrackArb);

export const subtitleTrackArb: Arbitrary<SubtitleTrack> = fc.record(
  {
    id: idArb,
    language: languageTagArb,
    kind: fc.constantFrom(...subtitleKindSchema.options),
    format: fc.constantFrom(...subtitleFormatSchema.options),
    isDefault: fc.boolean()
  },
  { noNullPrototype: true }
);

export const subtitleTracksArb: Arbitrary<SubtitleTrack[]> = distinctByIdArb(subtitleTrackArb);

export const subtitlePolicyArb: Arbitrary<SubtitlePolicy> = fc.record(
  {
    mode: fc.constantFrom(...subtitleModeSchema.options),
    preferredLanguages: fc.array(languageTagArb, { maxLength: 3 }),
    hearingImpaired: fc.boolean(),
    audioLanguage: fc.option(languageTagArb, { nil: null }),
    // Deliberately allowed to be empty: the contract says a client that renders
    // no timed text at all is a real client, and it rejects everything.
    supportedFormats: fc.uniqueArray(fc.constantFrom(...subtitleFormatSchema.options), {
      maxLength: subtitleFormatSchema.options.length
    })
  },
  { noNullPrototype: true }
);

export const failoverPolicyArb: Arbitrary<FailoverPolicy> = fc.record(
  {
    maxAttempts: fc.integer({ min: 1, max: 6 }),
    maxTransientRetriesPerCandidate: fc.integer({ min: 0, max: 3 })
  },
  { noNullPrototype: true }
);

/**
 * Reported failures naming ids from `pool`, plus ids that name nothing.
 *
 * The ghost ids are not noise. `planFailover` has an entire published surface —
 * `unattributedFailures`, `unattributedDetail` — that only exists for failures
 * reported against a candidate nobody ranked, and a generator drawing only from
 * the pool would leave both of those permanently empty.
 */
export function failuresArb(pool: readonly string[]): Arbitrary<PlaybackAttemptFailure[]> {
  const candidateIdArb =
    pool.length === 0
      ? fc.constantFrom("ghost-1", "ghost-2")
      : fc.oneof(fc.constantFrom(...pool), fc.constantFrom("ghost-1", "ghost-2"));
  return fc.array(
    fc.record({ candidateId: candidateIdArb, kind: playbackFailureKindArb }, { noNullPrototype: true }),
    { minLength: 0, maxLength: MAX_LIST_LENGTH }
  );
}
