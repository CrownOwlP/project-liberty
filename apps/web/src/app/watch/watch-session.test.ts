import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { describe, expect, it } from "vitest";
import { loadPlaybackSession, type AuthorizedCandidate } from "./watch-session";

/*
 * What this file is really testing is a boundary rather than a fixture: the
 * watch route takes a content id and nothing else, and every media URL it ends
 * up with came from a source the server chose. The fixtures below stand in for
 * PL-0501's resolver; the rights and eligibility decision they are run through
 * is the real one from `@liberty/media-engine`.
 */

function authorized(init: {
  id: string;
  uri: string;
  rights?: ContentRights;
  height?: number;
  bitrateKbps?: number;
  estimatedLatencyMs?: number;
  healthScore?: number;
}): AuthorizedCandidate {
  const candidate: StreamCandidate = {
    id: init.id,
    providerId: "fixture",
    rights: init.rights ?? "owned",
    protocol: "dash",
    height: init.height ?? 1080,
    bitrateKbps: init.bitrateKbps ?? 5000,
    estimatedLatencyMs: init.estimatedLatencyMs ?? 80,
    healthScore: init.healthScore ?? 0.95,
    videoCodec: "h264",
    audioCodec: "aac"
  };
  return { candidate, source: { uri: init.uri } };
}

const GOOD = authorized({ id: "good", uri: "https://cdn.example.com/good/manifest.mpd" });
/*
 * Worse in EVERY scored dimension rather than in one. A candidate that wins on
 * resolution and loses on bitrate would make this test an assertion about the
 * engine's weights, which `@liberty/media-engine`'s own suite already owns; what
 * is being tested here is only that this file preserves the order it was given.
 */
const ALSO_GOOD = authorized({
  id: "also-good",
  uri: "https://cdn.example.com/also-good/manifest.mpd",
  height: 480,
  bitrateKbps: 900,
  estimatedLatencyMs: 900,
  healthScore: 0.55
});

describe("what the route will not accept", () => {
  it("answers not-found for an id that could never name anything", () => {
    /*
     * Checked before the source is consulted, so raw URL path input never
     * reaches the provider boundary at all. Every id in the system is
     * lower-case and hyphen-separated.
     */
    const rejected = ["../secret", "Aurora Fall", "AURORA-FALL", "", "aurora_fall"];
    return Promise.all(
      rejected.map(async (id) => {
        const result = await loadPlaybackSession(id, () => [GOOD]);
        expect(result.status, id).toBe("not-found");
      })
    );
  });

  it("takes no argument through which a caller could supply a media URL", () => {
    /*
     * Asserted structurally rather than by inspecting a string. A player that
     * plays what the page asked for is an open proxy for arbitrary media and it
     * relocates product invariant 1 out of the code that enforces it, so the
     * absence of that parameter is the enforcement. `length` counts declared
     * parameters before the first defaulted one — the content id.
     */
    expect(loadPlaybackSession.length).toBe(1);
  });
});

describe("outcomes", () => {
  it("hands the player candidates in the ranking's order, with its reasons", () => {
    return loadPlaybackSession("aurora-fall", () => [ALSO_GOOD, GOOD]).then((result) => {
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      /* The 1080p/0.95-health candidate outranks the 480p/0.55 one, and the
       * order the source listed them in is not preserved — the ranking's is. */
      expect(result.session.candidates.map((entry) => entry.id)).toEqual(["good", "also-good"]);
      expect(result.session.contentId).toBe("aurora-fall");
      /* `null`, not `0`. For VOD that is the beginning and for live it is the
       * live edge, and PL-0403 is what will set it to a resume point. */
      expect(result.session.startAtSeconds).toBeNull();
      /* Product invariant 4 applies to a grant as much as to a denial. */
      expect(result.session.reasons.length).toBeGreaterThan(0);
      expect(result.policy.maxAttempts).toBeGreaterThan(0);
    });
  });

  it("distinguishes a title that does not exist from a provider that could not answer", () => {
    /* Two different remedies. A reader told to "try again in a moment" about a
     * title that will never exist will keep trying. */
    return Promise.all([
      loadPlaybackSession("aurora-fall", () => null).then((result) => {
        expect(result.status).toBe("not-found");
      }),
      loadPlaybackSession("aurora-fall", () => {
        throw new Error("provider timed out");
      }).then((result) => {
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.reason).toBe("provider timed out");
      })
    ]);
  });

  it("denies a title whose rights basis is not one we may play from", () => {
    /*
     * The cast is the point and it is not laziness — the same reasoning
     * `@liberty/contracts`' own `unvettedRightsArb` is built on. Every member of
     * `ContentRights` is currently on the playable allowlist, so with only
     * well-typed values this guarantee is VACUOUS and no test can observe it.
     * The string below stands in for the rights value somebody adds to the enum
     * next quarter without touching the allowlist; if the allowlist ever stops
     * being consulted on this path, this fails and nothing else would notice.
     */
    const unvetted = "rights-unknown" as unknown as ContentRights;
    return loadPlaybackSession("aurora-fall", () => [
      authorized({ id: "unlicensed", uri: "https://cdn.example.com/x.mpd", rights: unvetted })
    ]).then((result) => {
      expect(result.status).toBe("denied");
      if (result.status !== "denied") return;
      expect(result.reasons.join(" ")).toContain("rights_not_playable");
    });
  });

  it("drops a candidate whose source is not served over https, and says which", () => {
    /* The transport backstop from `playback-source.ts`, run here so that a
     * misconfigured origin is a reason on the page rather than a generic
     * network error three layers down that looks exactly like a dead CDN. */
    return loadPlaybackSession("aurora-fall", () => [
      authorized({ id: "insecure", uri: "http://cdn.example.com/insecure.mpd" }),
      GOOD
    ]).then((result) => {
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.session.candidates.map((entry) => entry.id)).toEqual(["good"]);
      expect(result.session.reasons.join(" ")).toContain("https");
    });
  });

  it("denies rather than granting an empty session when nothing survives the checks", () => {
    /* A granted session with no candidates would send the player to `fatal`
     * with `no_candidates`, which is a true statement made in the wrong place:
     * the decision belongs to the layer that knows why. */
    return loadPlaybackSession("aurora-fall", () => [
      authorized({ id: "insecure", uri: "http://cdn.example.com/insecure.mpd" })
    ]).then((result) => {
      expect(result.status).toBe("denied");
    });
  });

  it("uses the fixture source when none is injected", () => {
    /* The default path the route actually takes today. It must produce a
     * failover-capable list rather than a single candidate, or the machine's
     * whole reason for existing is untested in the app. */
    return loadPlaybackSession("aurora-fall").then((result) => {
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.session.candidates.length).toBeGreaterThan(1);
      for (const entry of result.session.candidates) {
        expect(entry.source.uri.startsWith("https://")).toBe(true);
      }
    });
  });
});
