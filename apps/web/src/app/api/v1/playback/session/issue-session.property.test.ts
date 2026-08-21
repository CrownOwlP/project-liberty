import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import {
  permutationKeysArb,
  permute,
  playbackCapabilitiesArb,
  streamCandidatesArb,
  unvettedRightsCandidatesArb
} from "@liberty/contracts/testing/arbitraries";
import { PLAYABLE_RIGHTS } from "@liberty/media-engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AuthorizedCandidate } from "./authorized-candidates";
import type { PlaybackSessionResponse } from "./contract";
import { issuePlaybackSession, type IssueSessionOptions } from "./issue-session";

/**
 * Session properties (fast-check).
 *
 * The example suite pins particular candidate lists. These pin the two things a
 * list of examples cannot: that the response is a function of the SET of
 * resolved candidates rather than of the order a provider happened to return
 * them in, and that no candidate whose rights we could not establish is ever
 * described in technical terms. Both are the kind of guarantee that holds for
 * the four cases somebody wrote down and fails for the fifth.
 *
 * DETERMINISM IS TREATED AS CORRECTNESS HERE. Six order-dependence defects have
 * been found in this repository; each one looked exactly like this property
 * passing for the three inputs a human chose. What is asserted is equality of
 * the WHOLE response -- outcome, session, and every line of the reason trail --
 * because a trail that reorders between two identical resolutions is a diff
 * nobody can review and a bug report nobody can reproduce.
 *
 * The seed is pinned by importing `@liberty/contracts/testing/arbitraries`,
 * which calls `fc.configureGlobal` on first import. The clock and the id
 * generator are injected below, so nothing here is time-dependent and no
 * counterexample can be a flake.
 */

const CONTENT_ID = "aurora-fall";

const FIXED: IssueSessionOptions = {
  now: () => new Date("2026-08-20T09:00:00.000Z"),
  newId: () => "fixed-id",
  localDeployment: false
};

/**
 * A URL-safe slug derived from a candidate id, so each candidate gets a
 * distinct source and the equality check has something to be wrong about.
 *
 * Hex code points rather than `encodeURIComponent`, because `idArb` deliberately
 * generates non-ASCII ids -- every id comparator in this repository is
 * documented as comparing by CODE POINT rather than by `localeCompare`, and an
 * ASCII-only generator cannot tell the two apart. This mapping is total over
 * any string, including a lone surrogate, which the percent-encoders are not.
 */
function slug(id: string): string {
  return [...id].map((character) => (character.codePointAt(0) ?? 0).toString(16)).join("-");
}

function authorize(candidate: StreamCandidate): AuthorizedCandidate {
  return {
    candidate,
    source: {
      uri: `https://fixtures.invalid/${slug(candidate.id)}/manifest.mpd`,
      mimeType: "application/dash+xml",
      allowLoopback: false
    }
  };
}

function issue(
  candidates: readonly AuthorizedCandidate[],
  capabilities: unknown
): Promise<PlaybackSessionResponse> {
  return issuePlaybackSession(
    { contentId: CONTENT_ID, capabilities },
    { ...FIXED, resolve: () => ({ status: "resolved", candidates }) }
  );
}

describe("the response is a function of the candidate set, not of its order", () => {
  it("answers any permutation of the same candidates identically", async () => {
    await fc.assert(
      fc.asyncProperty(
        streamCandidatesArb,
        playbackCapabilitiesArb,
        permutationKeysArb,
        async (candidates, capabilities, keys) => {
          const authorized = candidates.map(authorize);
          const first = await issue(authorized, capabilities);
          const second = await issue(permute(authorized, keys), capabilities);
          expect(second).toEqual(first);
        }
      )
    );
  });

  it("answers a reversed candidate list identically", async () => {
    /*
     * Beside the permutation property rather than instead of it: identity IS a
     * permutation, so the generated one can be trivial, and this suite must not
     * depend on the generator happening to produce a real reordering.
     */
    await fc.assert(
      fc.asyncProperty(unvettedRightsCandidatesArb, playbackCapabilitiesArb, async (candidates, capabilities) => {
        const authorized = candidates.map(authorize);
        const forward = await issue(authorized, capabilities);
        const backward = await issue([...authorized].reverse(), capabilities);
        expect(backward).toEqual(forward);
      })
    );
  });
});

describe("every decision arrives with its reasons", () => {
  it("carries a non-empty trail whatever the outcome", async () => {
    await fc.assert(
      fc.asyncProperty(unvettedRightsCandidatesArb, playbackCapabilitiesArb, async (candidates, capabilities) => {
        const response = await issue(candidates.map(authorize), capabilities);

        expect(response.reasons.length).toBeGreaterThan(0);
        for (const reason of response.reasons) {
          /* An empty detail would pass a length check on the array while
           * telling a reader nothing, so the trail is checked line by line. */
          expect(reason.detail.length).toBeGreaterThan(0);
        }
      })
    );
  });
});

describe("rights are settled before anything technical", () => {
  it("never describes an unrightsed candidate in technical terms", async () => {
    await fc.assert(
      fc.asyncProperty(unvettedRightsCandidatesArb, playbackCapabilitiesArb, async (candidates, capabilities) => {
        const response = await issue(candidates.map(authorize), capabilities);

        for (const candidate of candidates) {
          if (PLAYABLE_RIGHTS.includes(candidate.rights)) continue;

          /*
           * Exactly one line, and it is the rights one. Not "the rights reason
           * appears somewhere": a codec, height, health or URL reason beside it
           * would mean the candidate was compared against the device before its
           * rights were settled, and a viewer would be told their hardware was
           * the problem when the real answer is that we may not serve it.
           */
          expect(
            response.reasons
              .filter((reason) => reason.candidateId === candidate.id)
              .map((reason) => reason.code)
          ).toEqual(["rights_not_playable"]);
        }
      })
    );
  });
});

describe("a grant only ever publishes what was resolved", () => {
  it("never invents a candidate and never grants an empty session", async () => {
    await fc.assert(
      fc.asyncProperty(streamCandidatesArb, playbackCapabilitiesArb, async (candidates, capabilities) => {
        const authorized = candidates.map(authorize);
        const response = await issue(authorized, capabilities);
        if (response.outcome !== "granted") return;

        const offered = new Map(authorized.map((entry) => [entry.candidate.id, entry.source.uri]));

        expect(response.session.candidates.length).toBeGreaterThan(0);
        for (const published of response.session.candidates) {
          /* Every URL that leaves this server was one the resolver produced.
           * There is no path by which the route can synthesise, rewrite or
           * inherit one from the request. */
          expect(offered.get(published.id)).toBe(published.uri);
        }
      })
    );
  });
});
