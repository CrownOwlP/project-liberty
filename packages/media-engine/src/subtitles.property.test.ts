import type { SubtitleKind, SubtitlePolicy, SubtitleTrack } from "@liberty/contracts/domains/subtitles";
import { subtitleFormatSchema } from "@liberty/contracts/domains/subtitles";
import {
  defined,
  languageTagArb,
  permutationKeysArb,
  permute,
  subtitlePolicyArb,
  subtitleTrackArb,
  subtitleTracksArb
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import { selectSubtitleTrack } from "./subtitles";

/**
 * Subtitle selection properties (fast-check).
 *
 * `selectSubtitleTrack` makes the strongest determinism claim in the package:
 * "every list in the result is sorted by a comparator that terminates in a
 * code-point tiebreak on the track id, so the WHOLE result is order-invariant,
 * not merely `selected`". This suite is that sentence, checked — over generated
 * tracks and generated policies rather than over the fixtures somebody wrote.
 *
 * It also pins the two structural claims a naive port of `audio.ts` would get
 * wrong, both of which are invisible to a test that only reads `selected`:
 * nothing is a valid answer and it is the DEFAULT answer, and `off` suppresses
 * a selection without suppressing the MENU.
 */
const AUTO_SELECTABLE_KINDS: readonly SubtitleKind[] = ["subtitles", "sdh"];

/** A policy that can render everything, so the comparator is what is under test. */
const renderEverythingPolicyArb = fc
  .record(
    {
      preferredLanguages: fc.array(languageTagArb, { maxLength: 3 }),
      hearingImpaired: fc.boolean(),
      audioLanguage: fc.option(languageTagArb, { nil: null })
    },
    { noNullPrototype: true }
  )
  .map(
    ({ preferredLanguages, hearingImpaired, audioLanguage }): SubtitlePolicy => ({
      mode: "auto",
      preferredLanguages,
      hearingImpaired,
      audioLanguage,
      supportedFormats: [...subtitleFormatSchema.options]
    })
  );

function tripleOfKind(kind: SubtitleKind): Arbitrary<[SubtitleTrack, SubtitleTrack, SubtitleTrack]> {
  const ofKind = subtitleTrackArb.map((track): SubtitleTrack => ({ ...track, kind }));
  return fc
    .tuple(ofKind, ofKind, ofKind)
    .map(([a, b, c]): [SubtitleTrack, SubtitleTrack, SubtitleTrack] => [
      { ...a, id: `${a.id}#1` },
      { ...b, id: `${b.id}#2` },
      { ...c, id: `${c.id}#3` }
    ]);
}

const autoPoolTripleArb = fc
  .tuple(tripleOfKind("subtitles"), fc.constantFrom(...AUTO_SELECTABLE_KINDS))
  .map(([triple, kind]): [SubtitleTrack, SubtitleTrack, SubtitleTrack] => [
    triple[0],
    { ...triple[1], kind },
    triple[2]
  ]);

const forcedTripleArb = tripleOfKind("forced");

describe("the WHOLE selection is invariant under input order", () => {
  it("produces an identical SubtitleSelection for any permutation of the tracks", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, permutationKeysArb, (tracks, policy, keys) => {
        expect(selectSubtitleTrack(permute(tracks, keys), policy)).toEqual(
          selectSubtitleTrack(tracks, policy)
        );
      })
    );
  });

  it("produces an identical SubtitleSelection for the reversed tracks", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        expect(selectSubtitleTrack([...tracks].reverse(), policy)).toEqual(
          selectSubtitleTrack(tracks, policy)
        );
      })
    );
  });
});

describe("the selection is stable across repeats and is its own fixed point", () => {
  // Same argument as `audio.property.test.ts`: a permutation property fixes the
  // relation between two calls made inside one test body and says nothing about
  // ambient state that only shows up on a later call. Mutation is not checked
  // because the parameter is `readonly SubtitleTrack[]`.
  it("returns the identical SubtitleSelection however many times it is called", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const first = selectSubtitleTrack(tracks, policy);
        expect(selectSubtitleTrack(tracks, policy)).toEqual(first);
        expect(selectSubtitleTrack(tracks, policy)).toEqual(first);
      })
    );
  });

  it("is a fixed point of the order it publishes", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const byId = new Map(tracks.map((track) => [track.id, track]));
        const first = selectSubtitleTrack(tracks, policy);
        const asPublished: SubtitleTrack[] = [
          ...first.ordered,
          ...first.forced,
          ...first.manualOnly,
          ...first.rejected.map((entry) => defined(byId.get(entry.trackId), entry.trackId))
        ];

        expect(selectSubtitleTrack(asPublished, policy)).toEqual(first);
      })
    );
  });
});

describe("the four returned lists partition the input", () => {
  it("places every track in exactly one of ordered, forced, manualOnly or rejected", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const selection = selectSubtitleTrack(tracks, policy);
        const placed = [
          ...selection.ordered.map((track) => track.id),
          ...selection.forced.map((track) => track.id),
          ...selection.manualOnly.map((track) => track.id),
          ...selection.rejected.map((entry) => entry.trackId)
        ];

        /*
         * The partition is claimed to be exhaustive BY CONSTRUCTION, so that a
         * kind added to the contract later is offered rather than dropped —
         * dropping it would be invisible, since the track would simply cease to
         * exist for every consumer of this selection. This is that claim, over
         * generated input.
         */
        expect([...placed].sort()).toEqual([...tracks.map((track) => track.id)].sort());
        expect(new Set(placed).size).toBe(placed.length);
      })
    );
  });

  it("returns the same four lists in every branch, including the terminal ones", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        // The lists are built once and spread into every return, so a path that
        // quietly returned an empty `rejected` would make the reason trail
        // depend on which outcome you happened to hit.
        const selection = selectSubtitleTrack(tracks, policy);
        const rejectedIds = selection.rejected.map((entry) => entry.trackId);
        const unrenderableIds = tracks
          .filter((track) => !policy.supportedFormats.includes(track.format))
          .map((track) => track.id);
        expect([...rejectedIds].sort()).toEqual([...unrenderableIds].sort());
      })
    );
  });
});

describe("off suppresses the selection, never the menu", () => {
  it("offers exactly the same four lists whether the viewer is reading or not", () => {
    /*
     * The deliberate divergence from `AudioSelection.ordered`, which returns []
     * on every non-selection path. Emptying these lists when the viewer is off
     * would make "you turned these off" and "this title has none" identical
     * payloads — the exact conflation this policy exists to avoid.
     */
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const reading = selectSubtitleTrack(tracks, { ...policy, mode: "auto" });
        const off = selectSubtitleTrack(tracks, { ...policy, mode: "off" });

        expect(off.ordered).toEqual(reading.ordered);
        expect(off.forced).toEqual(reading.forced);
        expect(off.manualOnly).toEqual(reading.manualOnly);
        expect(off.rejected).toEqual(reading.rejected);
      })
    );
  });

  it("puts nothing on screen with subtitles off except a forced narrative track", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const off = selectSubtitleTrack(tracks, { ...policy, mode: "off" });
        if (off.selected !== null) {
          expect(off.selected.kind).toBe("forced");
          expect(off.reason).toBe("forced_narrative_with_subtitles_off");
        }
      })
    );
  });
});

describe("subtitles never appear uninvited", () => {
  it("never selects a commentary or unrecognised kind, for any input", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const selection = selectSubtitleTrack(tracks, policy);
        if (selection.selected === null) return;

        const { selected } = selection;
        expect(["subtitles", "sdh", "forced"]).toContain(selected.kind);

        if (selected.kind === "forced") {
          expect(selection.forced).toContainEqual(selected);
        } else {
          // Every language match sits ahead of every non-match, so the head is a
          // match if and only if one exists — which is why testing the head is
          // the whole test, and why nothing below the head may ever be selected.
          expect(selected).toEqual(selection.ordered[0]);
        }
      })
    );
  });

  it("selects nothing when no language was ever stated", () => {
    fc.assert(
      fc.property(subtitleTracksArb, renderEverythingPolicyArb, (tracks, policy) => {
        const silent: SubtitlePolicy = {
          ...policy,
          preferredLanguages: [],
          hearingImpaired: false,
          audioLanguage: null
        };
        const selection = selectSubtitleTrack(tracks, silent);
        // Unlike audio, where something must play, the correct default here is
        // nothing on screen. With no audio language there is no forced track to
        // fall back to either.
        expect(selection.selected).toBeNull();
      })
    );
  });
});

describe("both comparators are total orders", () => {
  function winnerOf(a: SubtitleTrack, b: SubtitleTrack, policy: SubtitlePolicy, pool: "ordered" | "forced"): string {
    const selection = selectSubtitleTrack([a, b], policy);
    return defined(selection[pool][0], `head of the ${pool} pool`).id;
  }

  it("orders the automatic pool antisymmetrically and transitively", () => {
    fc.assert(
      fc.property(autoPoolTripleArb, renderEverythingPolicyArb, ([a, b, c], policy) => {
        expect(winnerOf(a, b, policy, "ordered")).toBe(winnerOf(b, a, policy, "ordered"));
        if (winnerOf(a, b, policy, "ordered") === a.id && winnerOf(b, c, policy, "ordered") === b.id) {
          expect(winnerOf(a, c, policy, "ordered")).toBe(a.id);
        }
      })
    );
  });

  it("orders the forced pool antisymmetrically and transitively", () => {
    /*
     * A separate comparator with a separate question — a forced track is keyed
     * to the AUDIO language, not to what the viewer likes to read — so its laws
     * have to be checked separately. It also carries a documented GAP (no
     * closer-variant rule between two non-exact fits); a gap is not an excuse
     * for intransitivity, and this is what says so.
     */
    fc.assert(
      fc.property(forcedTripleArb, renderEverythingPolicyArb, ([a, b, c], policy) => {
        expect(winnerOf(a, b, policy, "forced")).toBe(winnerOf(b, a, policy, "forced"));
        if (winnerOf(a, b, policy, "forced") === a.id && winnerOf(b, c, policy, "forced") === b.id) {
          expect(winnerOf(a, c, policy, "forced")).toBe(a.id);
        }
      })
    );
  });

  it("sorts rejections by code-point track id, strictly", () => {
    fc.assert(
      fc.property(subtitleTracksArb, subtitlePolicyArb, (tracks, policy) => {
        const { rejected } = selectSubtitleTrack(tracks, policy);
        for (let index = 1; index < rejected.length; index++) {
          const previous = defined(rejected[index - 1], "previous rejection");
          const current = defined(rejected[index], "current rejection");
          expect(previous.trackId < current.trackId).toBe(true);
        }
      })
    );
  });
});
