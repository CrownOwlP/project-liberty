import type { AudioRole, AudioTrack } from "@liberty/contracts/domains/audio";
import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";
import { audioCodecSchema, videoCodecSchema } from "@liberty/contracts/shared/codecs";
import {
  audioTrackArb,
  audioTracksArb,
  defined,
  languageTagArb,
  permutationKeysArb,
  permute,
  playbackCapabilitiesArb
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { languageMatch, primarySubtag, selectAudioTrack } from "./audio";

/**
 * Audio selection properties (fast-check).
 *
 * `selectAudioTrack` claims, in its own doc comment, to be "pure and
 * deterministic: same tracks and capabilities in, same selection out, regardless
 * of input ordering". That claim was FALSE for three of the four returned lists
 * at one point or another — `manualOnly` preserved provider input order while
 * `rejected` was sorted, so reversing the incoming tracks changed the result
 * even though `selected` never moved. Both defects were found by hand.
 *
 * The properties here therefore compare the WHOLE `AudioSelection`. A property
 * that only checked the winner would have passed on both defects.
 *
 * Roles eligible for automatic selection are named here rather than imported
 * because `AUTO_SELECTABLE_ROLES` is module-private. That is deliberate: the
 * invariant a viewer cares about is "audio description and commentary are never
 * selected for someone who did not ask", and stating it in the test's own terms
 * means the test still fails if the private constant is widened.
 */
const AUTO_SELECTABLE: readonly AudioRole[] = ["original", "main", "dub"];
const MANUAL_ONLY: readonly AudioRole[] = ["descriptive", "commentary"];

/** Capabilities that reject nothing, so the comparator is what is under test. */
const permissiveCapabilitiesArb = fc
  .record({ preferredAudioLanguages: fc.array(languageTagArb, { maxLength: 3 }) }, { noNullPrototype: true })
  .map(
    ({ preferredAudioLanguages }): PlaybackCapabilities => ({
      maxHeight: 2160,
      supportedVideoCodecs: [...videoCodecSchema.options],
      supportedAudioCodecs: [...audioCodecSchema.options],
      preferredAudioLanguages
    })
  );

const autoSelectableTrackArb = fc
  .tuple(audioTrackArb, fc.constantFrom(...AUTO_SELECTABLE))
  .map(([track, role]): AudioTrack => ({ ...track, role }));

/**
 * Three tracks with ids that are distinct BY CONSTRUCTION.
 *
 * Suffixed rather than filtered for uniqueness, so the generator can never fail
 * to produce a triple, and the underlying ids still vary — which matters,
 * because the last tiebreak in the comparator is the id and a generator that
 * only ever produced distinct-by-luck ids would exercise it thinly.
 */
const distinctTripleArb = fc
  .tuple(autoSelectableTrackArb, autoSelectableTrackArb, autoSelectableTrackArb)
  .map(([a, b, c]): [AudioTrack, AudioTrack, AudioTrack] => [
    { ...a, id: `${a.id}#1` },
    { ...b, id: `${b.id}#2` },
    { ...c, id: `${c.id}#3` }
  ]);

function orderedIds(tracks: readonly AudioTrack[], capabilities: PlaybackCapabilities): string[] {
  return selectAudioTrack(tracks, capabilities).ordered.map((track) => track.id);
}

/** Which of two eligible, auto-selectable tracks the policy puts first. */
function winnerOf(a: AudioTrack, b: AudioTrack, capabilities: PlaybackCapabilities): string {
  return defined(orderedIds([a, b], capabilities)[0], "head of a two-track ordering");
}

describe("the WHOLE selection is invariant under input order", () => {
  it("produces an identical AudioSelection for any permutation of the tracks", () => {
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, permutationKeysArb, (tracks, capabilities, keys) => {
        expect(selectAudioTrack(permute(tracks, keys), capabilities)).toEqual(
          selectAudioTrack(tracks, capabilities)
        );
      })
    );
  });

  it("produces an identical AudioSelection for the reversed tracks", () => {
    // The permutation that found the `manualOnly` defect by hand.
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        expect(selectAudioTrack([...tracks].reverse(), capabilities)).toEqual(
          selectAudioTrack(tracks, capabilities)
        );
      })
    );
  });
});

describe("the selection is stable across repeats and is its own fixed point", () => {
  /*
   * Not a redundant restatement of the permutation properties above.
   *
   * A permutation property fixes the RELATION between two calls made inside one
   * test body. It says nothing about a call made later: a memo keyed on something
   * incidental, a lazily-initialised module constant, or any other ambient state
   * the "pure and deterministic" doc comment rules out by assertion rather than
   * by construction. The env-validator defect in this repository was exactly a
   * derived value keyed on something incidental, so the class is live.
   *
   * Mutation of the caller's array is deliberately NOT checked here, unlike in
   * `ranking.property.test.ts`: `selectAudioTrack` takes `readonly AudioTrack[]`,
   * so the compiler already forbids the in-place sort that property guards
   * against. `rankStreamCandidates` takes a mutable array and does not.
   */
  it("returns the identical AudioSelection however many times it is called", () => {
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        const first = selectAudioTrack(tracks, capabilities);
        expect(selectAudioTrack(tracks, capabilities)).toEqual(first);
        expect(selectAudioTrack(tracks, capabilities)).toEqual(first);
      })
    );
  });

  it("is a fixed point of the order it publishes", () => {
    // Sorting an already-sorted list changes nothing. A corollary of permutation
    // invariance, but the corollary a reviewer checks by hand -- and the one that
    // fails legibly rather than on some unrelated-looking shuffle.
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        const byId = new Map(tracks.map((track) => [track.id, track]));
        const first = selectAudioTrack(tracks, capabilities);
        const asPublished: AudioTrack[] = [
          ...first.ordered,
          ...first.manualOnly,
          ...first.rejected.map((entry) => defined(byId.get(entry.trackId), entry.trackId))
        ];

        expect(selectAudioTrack(asPublished, capabilities)).toEqual(first);
      })
    );
  });
});

describe("the comparator is a total order", () => {
  /*
   * `compareTracks` is module-private, so its laws are checked through the
   * public policy: `ordered` IS the comparator applied to a pool. An
   * intransitive comparator produces engine-dependent output from
   * `Array.prototype.sort` — a determinism bug that survives every example test,
   * because an example fixes one input order and never sees the disagreement.
   */
  it("is antisymmetric and total: two distinct tracks always order the same way round", () => {
    fc.assert(
      fc.property(distinctTripleArb, permissiveCapabilitiesArb, ([a, b], capabilities) => {
        expect(winnerOf(a, b, capabilities)).toBe(winnerOf(b, a, capabilities));
      })
    );
  });

  it("is transitive", () => {
    fc.assert(
      fc.property(distinctTripleArb, permissiveCapabilitiesArb, ([a, b, c], capabilities) => {
        const aBeatsB = winnerOf(a, b, capabilities) === a.id;
        const bBeatsC = winnerOf(b, c, capabilities) === b.id;
        if (aBeatsB && bBeatsC) expect(winnerOf(a, c, capabilities)).toBe(a.id);
      })
    );
  });

  it("orders a triple consistently with every pair inside it", () => {
    fc.assert(
      fc.property(distinctTripleArb, permissiveCapabilitiesArb, (triple, capabilities) => {
        const byId = new Map(triple.map((track) => [track.id, track]));
        const ordered = orderedIds(triple, capabilities);
        expect(ordered).toHaveLength(3);

        for (let index = 1; index < ordered.length; index++) {
          const previous = defined(byId.get(defined(ordered[index - 1], "previous id")), "previous track");
          const current = defined(byId.get(defined(ordered[index], "current id")), "current track");
          expect(winnerOf(previous, current, capabilities)).toBe(previous.id);
        }
      })
    );
  });
});

describe("the four returned lists partition the input", () => {
  it("places every track in exactly one of ordered, manualOnly or rejected", () => {
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        const selection = selectAudioTrack(tracks, capabilities);
        const placed = [
          ...selection.ordered.map((track) => track.id),
          ...selection.manualOnly.map((track) => track.id),
          ...selection.rejected.map((entry) => entry.trackId)
        ];

        /*
         * Exhaustive except for one branch the policy documents: when tracks are
         * eligible but none is auto-selectable, `ordered` is deliberately empty
         * — and so is the auto-selectable pool, so the partition still holds.
         * Asserting it over generated input is what proves that, rather than
         * trusting the reading.
         */
        expect([...placed].sort()).toEqual([...tracks.map((track) => track.id)].sort());
        expect(new Set(placed).size).toBe(placed.length);
      })
    );
  });

  it("sorts rejections by code-point track id, strictly", () => {
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        const { rejected } = selectAudioTrack(tracks, capabilities);
        for (let index = 1; index < rejected.length; index++) {
          const previous = defined(rejected[index - 1], "previous rejection");
          const current = defined(rejected[index], "current rejection");
          expect(previous.trackId < current.trackId).toBe(true);
        }
      })
    );
  });
});

describe("nobody is given commentary or audio description by accident", () => {
  it("never automatically selects a manual-only role, for any input", () => {
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        const selection = selectAudioTrack(tracks, capabilities);
        if (selection.selected !== null) {
          expect(MANUAL_ONLY).not.toContain(selection.selected.role);
          expect(AUTO_SELECTABLE).toContain(selection.selected.role);
          // The head of the ranking IS the selection; nothing else may be.
          expect(selection.selected).toEqual(selection.ordered[0]);
        }

        for (const track of selection.ordered) expect(AUTO_SELECTABLE).toContain(track.role);
        for (const track of selection.manualOnly) expect(AUTO_SELECTABLE).not.toContain(track.role);
      })
    );
  });

  it("tells an empty stream apart from an unplayable one", () => {
    fc.assert(
      fc.property(audioTracksArb, playbackCapabilitiesArb, (tracks, capabilities) => {
        const selection = selectAudioTrack(tracks, capabilities);
        if (selection.reason === "no_audio_tracks") expect(tracks).toHaveLength(0);
        if (tracks.length === 0) expect(selection.reason).toBe("no_audio_tracks");
      })
    );
  });
});

describe("languageMatch reports two independent coordinates", () => {
  it("is case- and whitespace-insensitive on both sides", () => {
    /*
     * The policies take the TYPE rather than parsed output, so the schema's
     * lower-casing `.transform()` never runs on a track an adapter constructed
     * by hand. If this function were case-sensitive, an exported caller passing
     * "EN-GB" would silently match nothing.
     */
    fc.assert(
      fc.property(languageTagArb, fc.array(languageTagArb, { maxLength: 4 }), (language, preferred) => {
        const asWritten = languageMatch(language, preferred);
        const shouted = languageMatch(
          language.toUpperCase(),
          preferred.map((tag) => `  ${tag.toUpperCase()}  `)
        );
        expect(shouted).toEqual(asWritten);
      })
    );
  });

  it("never reports an exact match earlier than the language group it belongs to", () => {
    fc.assert(
      fc.property(languageTagArb, fc.array(languageTagArb, { maxLength: 4 }), (language, preferred) => {
        const match = languageMatch(language, preferred);
        if (match === null) return;

        expect(match.groupIndex).toBeGreaterThanOrEqual(0);
        expect(match.groupIndex).toBeLessThan(preferred.length);

        const group = defined(preferred[match.groupIndex], "matched group preference");
        expect(primarySubtag(group)).toBe(primarySubtag(language));

        if (match.exactIndex !== null) {
          // An exact match is a member of its own group, so it can never sit
          // before the group's first index. Collapsing the two coordinates into
          // one is what made an unrequested "en-au" beat a listed "en-gb".
          expect(match.exactIndex).toBeGreaterThanOrEqual(match.groupIndex);
          const exact = defined(preferred[match.exactIndex], "matched exact preference");
          expect(exact.trim().toLowerCase()).toBe(language.toLowerCase());
        }
      })
    );
  });
});
