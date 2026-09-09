import { unknownMediaFacts, type StreamCandidate } from "@liberty/contracts/domains/playback";
import { MEDIA_FACTS } from "@liberty/contracts/shared/media-facts";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { afterEach, describe, expect, it } from "vitest";
import {
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment
} from "../api/deployment-environment";
import {
  fixtureProvider,
  type FixtureProvider
} from "../api/v1/playback/session/authorized-candidates";
import {
  isWatchableContentId,
  loadPlaybackSession,
  type AuthorizedCandidate,
  type AuthorizedCandidateResolver
} from "./watch-session";

/*
 * What this file is really testing is a boundary rather than a fixture: the
 * watch route takes a content id and nothing else, and every media URL it ends
 * up with came from a source the server chose.
 *
 * The candidates below stand in for a provider registry; the rights and
 * eligibility decision they are run through is the real one from
 * `@liberty/media-engine`, and the transport decision is the real outbound URL
 * policy from `@liberty/provider-sdk`. The DEFAULT path reaches the one fixture
 * provider there is — `@liberty/provider-sdk`'s adapter, configured by the
 * session API — through that module's resolver, imported rather than restated.
 * The second copy that used to live in `watch-session.ts` is what PL-0301
 * removed, and the third that briefly lived in the session API itself is what
 * this corrective removed.
 */

const CONTENT_ID = "aurora-fall";

/** The correlation id the route generates per request; a literal here. */
const CONTEXT = { requestId: "watch-test" } as const;

/**
 * The fixture candidates this route would serve, over an origin the test chose.
 *
 * `fixtureProvider` takes a `NonDeploymentEnvironment`, which only
 * `@liberty/contracts/shared/runtime` can mint -- `api/deployment-environment.ts`
 * is this app's door to it -- and only for a `NODE_ENV` on the one allowlist. So
 * the fabricated `owned` declaration is a value this route could not construct
 * on a build that ships, rather than one it constructs and then declines to use.
 * `test` is the environment vitest sets.
 *
 * BUILT PER CALL AND SAFE INSIDE A TEST THAT HAS REWRITTEN `NODE_ENV`, because
 * construction is a pure function of the witness and the origin: the deployment
 * half of the loopback permission is answered from the witness's own recorded
 * `nodeEnv`, and nothing under `@liberty/provider-sdk` reads the environment at
 * all. The tests that set `NODE_ENV=production` are asserting what a hosted
 * process does to a candidate it was GIVEN, and this helper keeps producing one.
 *
 * The origin is REQUIRED rather than defaulted: the module default is
 * `LIBERTY_FIXTURE_MEDIA_ORIGIN`, and a test whose expectations depend on an
 * operator's `.env.local` passes on one machine and fails on another.
 */
function fixtures(origin: string): FixtureProvider {
  const environment = NonDeploymentEnvironment.classify("test");
  if (environment === null) {
    throw new Error("`test` is no longer on NON_DEPLOYMENT_ENVIRONMENTS");
  }

  const created = fixtureProvider(environment, origin);
  if (created.status === "refused") {
    throw new Error(`the fixture provider refused ${created.reason}: ${created.detail}`);
  }
  return created.provider;
}

/** The candidates a pinned origin produces. */
function fixtureCandidates(contentId: string, origin: string): readonly AuthorizedCandidate[] {
  return fixtures(origin).candidates(contentId, CONTEXT);
}

/**
 * `process.env.NODE_ENV` is typed as a three-value union by Next's ambient
 * declarations, and half of what is under test here is the values OUTSIDE that
 * union — `staging`, the empty string, unset. Written through a widened view of
 * the same object so the test can express the states a real deployment can
 * actually be in. Mirrors `authorized-candidates.test.ts`.
 */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env["NODE_ENV"];
  else env["NODE_ENV"] = value;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
});

function authorized(init: {
  id: string;
  uri: string;
  rights?: ContentRights;
  height?: number;
  bitrateKbps?: number;
  estimatedLatencyMs?: number;
  healthScore?: number;
  allowLoopback?: boolean;
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
  /*
   * `allowLoopback` and a nullable `mimeType` are part of the source now,
   * because the route adopted the session API's `AuthorizedCandidate` instead
   * of keeping a narrower private copy. The narrower copy is precisely why this
   * route could not run the real URL policy: it had nowhere to carry the
   * source's half of the loopback permission.
   */
  return {
    candidate,
    source: { uri: init.uri, mimeType: null, allowLoopback: init.allowLoopback ?? false }
  };
}

/** A resolver that answers with a fixed candidate list. */
function resolving(...candidates: AuthorizedCandidate[]): AuthorizedCandidateResolver {
  return () => ({ status: "resolved", candidates });
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
     * Checked before the resolver is consulted, so raw URL path input never
     * reaches the provider boundary at all. Every id in the system is
     * lower-case and hyphen-separated.
     */
    const rejected = ["../secret", "Aurora Fall", "AURORA-FALL", "", "aurora_fall"];
    return Promise.all(
      rejected.map(async (id) => {
        const result = await loadPlaybackSession(id, resolving(GOOD));
        expect(result.status, id).toBe("not-found");
      })
    );
  });

  it("refuses exactly the same ids through the gate the route runs above Suspense", async () => {
    /*
     * PL-0704. `[contentId]/page.tsx` asks `isWatchableContentId` BEFORE it
     * renders anything, because a status line precedes the first body byte and
     * a `<Suspense>` fallback is body bytes: an existence decision taken inside
     * the boundary is taken after the 200 has shipped. That only produces the
     * right 404 if the gate and the loader agree about which ids name nothing —
     * two predicates would mean a page that renders for an id the loader then
     * calls not-found, back under a flushed 200.
     *
     * Asserted in both directions, so neither side can drift into being the
     * stricter one. Only the reachable half is covered: `loadPlaybackSession`
     * has a second `not-found`, from a resolver reporting that a WELL-FORMED id
     * names nothing, which no resolver produces yet and which the page renders
     * as a panel rather than as a 404 it cannot send.
     */
    const ids = ["../secret", "Aurora Fall", "AURORA-FALL", "", "aurora_fall", CONTENT_ID, "a-1"];

    await Promise.all(
      ids.map(async (id) => {
        const result = await loadPlaybackSession(id, resolving(GOOD));
        expect(isWatchableContentId(id), id).toBe(result.status !== "not-found");
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

  it("never lets a traversal id escape the configured origin's path prefix", async () => {
    /*
     * Belt and braces across two layers. The route refuses the id above, and the
     * fixture provider independently refuses to interpolate one — dots are
     * unreserved, so percent-encoding is not a defence and `..` would otherwise
     * walk out of the prefix. Reached through the seam because the route's own
     * check makes it unreachable through the front door.
     */
    expect(fixtureCandidates("../../etc/passwd", "https://rig.test/media")).toEqual([]);

    const result = await loadPlaybackSession(CONTENT_ID, () => ({
      status: "resolved",
      candidates: fixtureCandidates(CONTENT_ID, "https://rig.test/media")
    }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const entry of result.session.candidates) {
      const url = new URL(entry.source.uri);
      expect(url.origin).toBe("https://rig.test");
      expect(url.pathname.startsWith(`/media/${CONTENT_ID}/`)).toBe(true);
    }
  });
});

describe("where the fixture path may run", () => {
  /*
   * THE REGRESSION THIS FILE EXISTS FOR. This route had no environment guard of
   * any kind: `[contentId]/page.tsx` calls `loadPlaybackSession(contentId)` with
   * the default source, so `next start` rendered a player aimed at candidates
   * declaring `owned` rights over files nothing had ever opened. The guard is
   * not a second copy of the rule — it is the session API's resolver, reached
   * through the same allowlist.
   */
  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("serves fixtures under NODE_ENV=%s", async (value) => {
    /*
     * AN EXPLICIT ALLOWED SET, not `not.toBe("not-configured")`. That form is
     * also satisfied by `not-found`, so a route that had stopped recognising
     * this id would have passed the gate test for the gate it was meant to
     * prove open.
     *
     * THE SET GREW BY ONE WHEN THE FIXTURE ADAPTER MOVED BEHIND THE PROVIDER
     * BOUNDARY, and the third member is not a tolerance. The outcome still
     * depends on where an operator pointed `LIBERTY_FIXTURE_MEDIA_ORIGIN`, but
     * the gate that refuses a bad rig now runs EARLIER: the SDK checks the
     * origin with the same outbound URL policy at construction, so a rig on a
     * private host is refused before any candidate exists and the resolver
     * answers `provider-unavailable`, which this route renders as `error` with
     * the policy's named reason. Previously the same rig produced three
     * candidates that this route's own gate dropped one at a time, landing as
     * `denied`. Both are refusals with a reason trail; which one an operator
     * sees is a property of their origin. `not-found` and `not-configured`
     * remain excluded, and `not-configured` is the only answer the ENVIRONMENT
     * gate produces, which is what this test is about. The happy path is pinned
     * separately, with an origin this file chooses.
     */
    setNodeEnv(value);
    const result = await loadPlaybackSession(CONTENT_ID);
    expect(["ok", "denied", "error"], `NODE_ENV=${value}`).toContain(result.status);
  });

  it.each(["production", "staging", "preview", "Production", "PRODUCTION", ""])(
    "serves nothing under NODE_ENV=%j",
    async (value) => {
      /* Every one of these used to render a player. A denylist of the single
       * string `production` admitted all of them. */
      setNodeEnv(value);
      const result = await loadPlaybackSession(CONTENT_ID);
      expect(result).toEqual({ status: "not-configured", contentId: CONTENT_ID });
    }
  );

  it("serves nothing when NODE_ENV is unset", async () => {
    setNodeEnv(undefined);
    const result = await loadPlaybackSession(CONTENT_ID);
    expect(result).toEqual({ status: "not-configured", contentId: CONTENT_ID });
  });

  it("reports not-configured as itself rather than as a denial or a retryable error", async () => {
    /*
     * The three have three different remedies and only one of them is the
     * operator's. `denied` would blame this title's rights for an unconfigured
     * deployment, and `error` invites a retry that no amount of waiting
     * resolves.
     */
    setNodeEnv("production");
    const result = await loadPlaybackSession(CONTENT_ID);
    expect(result.status).not.toBe("denied");
    expect(result.status).not.toBe("error");
    expect(result.status).not.toBe("ok");
  });
});

describe("the fixtures the route actually serves", () => {
  it("is the one provider's set, not a second one declared here", () => {
    /*
     * The duplicate this route once carried stated `rights: "owned"` as a bare
     * literal, invented h264/aac and heights, and had its own origin read. What
     * is left is one provider -- `@liberty/provider-sdk`'s, configured by the
     * session API and reached from here through its resolver -- and the ids, the
     * rights and the (absent) media facts all come from it.
     */
    const provider = fixtures("https://rig.test/media");
    for (const entry of provider.candidates(CONTENT_ID, CONTEXT)) {
      expect(entry.candidate.rights).toBe(provider.rightsBasis.rights);
      /* Every media fact unknown. A fixture claiming the most widely supported
       * codec pair in existence passed eligibility BECAUSE the values were ones
       * every device accepts, and the session then reported `verified` for a
       * file nobody had opened. */
      expect(unknownMediaFacts(entry.candidate)).toEqual([...MEDIA_FACTS]);
    }
  });

  it("publishes an unverified trail, because no codec was ever established", async () => {
    /* Origin pinned so the assertion is about the fixtures rather than about
     * the machine the suite runs on. */
    const result = await loadPlaybackSession(CONTENT_ID, () => ({
      status: "resolved",
      candidates: fixtureCandidates(CONTENT_ID, "https://rig.test")
    }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    /* The engine appends the missing facts to each ranked candidate's reason.
     * If a fabricated codec ever reappears, this line goes quiet. */
    for (const entry of result.session.candidates) {
      expect(result.session.reasons.some((reason) => reason.startsWith(`${entry.id}:`))).toBe(true);
    }
    expect(result.session.reasons.join(" ")).toContain("unverified");
  });
});

describe("the transport gate", () => {
  /*
   * `checkPlaybackSource` accepts ANY `https:` URL. It is in
   * `components/player/**`, which PL-0301 may not write, so the asymmetry is
   * closed from this side instead: the route runs the provider SDK's `checkUrl`
   * first and only ever hands the weaker checker a URL the policy already
   * parsed and accepted.
   */

  /**
   * A resolved candidate carrying exactly the URI under test.
   *
   * HAND-BUILT RATHER THAN COMPOSED BY THE FIXTURE PROVIDER, and the change is
   * the point rather than a convenience. What this block asserts is THIS
   * ROUTE'S gate: `toPlaybackCandidates` runs `checkUrl` over whatever a
   * resolver handed it, immediately before a URL reaches a browser. The fixture
   * provider now refuses these origins at construction -- it runs the same
   * policy over the operator's origin -- so feeding them through it would test
   * the SDK's gate twice and this route's not at all, and the day a real
   * provider registry lands behind this seam it is a resolver this route does
   * not control that has to be checked. The provider's own origin refusals are
   * asserted where they happen, in
   * `api/v1/playback/session/authorized-candidates.test.ts`.
   *
   * The source states `allowLoopback: false`, which is what a source that did
   * not opt in says. None of the addresses below is loopback, so it is the
   * honest value rather than a convenient one; the loopback pair is asserted
   * separately, over the fixture provider's own output, because there both
   * halves of that permission have to be present.
   */
  function withUri(uri: string) {
    return loadPlaybackSession(CONTENT_ID, resolving(authorized({ id: "under-test", uri })));
  }

  it.each([
    ["https://user:pass@rig.test/media/720p.mp4", "url_credentials_present"],
    ["https://169.254.169.254/media/720p.mp4", "url_private_address"],
    ["http://169.254.169.254/media/720p.mp4", "url_private_address"],
    ["https://10.0.0.5/media/720p.mp4", "url_private_address"],
    ["https://[fd00::1]/media/720p.mp4", "url_private_address"],
    ["https://rig.internal/media/720p.mp4", "url_private_address"],
    ["http://cdn.example.test/media/720p.mp4", "url_plaintext_http_not_loopback"]
  ])("refuses a candidate at %s as %s, and plays nothing", async (uri, reason) => {
    const result = await withUri(uri);
    /* Denied rather than a granted session with an empty candidate list: a
     * grant with nothing in it sends the player to `fatal` with `no_candidates`,
     * which is a true statement made in the wrong place. */
    expect(result.status).toBe("denied");
    if (result.status !== "denied") return;
    expect(result.reasons.join(" ")).toContain(reason);
  });

  it("does not echo an embedded credential into the reason trail", async () => {
    /* The trail is rendered on the page and goes into a bug report screenshot.
     * `url-policy.ts` names the failure without repeating the URL, and nothing
     * here re-adds it. */
    const result = await withUri("https://user:secret-token@rig.test/media/720p.mp4");
    expect(result.status).toBe("denied");
    if (result.status !== "denied") return;
    expect(result.reasons.join(" ")).not.toContain("secret-token");
  });

  it("still admits a public https origin", async () => {
    const result = await withUri("https://rig.test/media/720p.mp4");
    expect(result.status).toBe("ok");
  });

  it("runs over the fixture provider's own output too", async () => {
    /*
     * The gate is not bypassed for candidates that came from the provider this
     * route actually uses -- it runs over whatever the resolver returned. The
     * pinned origin is one the URL policy admits, so what this asserts is that
     * all three survive rather than that any of them is dropped.
     */
    const result = await loadPlaybackSession(CONTENT_ID, () => ({
      status: "resolved",
      candidates: fixtureCandidates(CONTENT_ID, "https://rig.test/media")
    }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session.candidates.length).toBe(3);
  });

  it("needs both halves of the loopback permission, not just the source's", async () => {
    /*
     * `url-policy.ts` requires two independently-owned facts and this route now
     * supplies both honestly: the source half is derived from the origin, and
     * the deployment half is `NODE_ENV`. Under a hosted environment a local rig
     * is refused — which is the case that matters, because on a hosted instance
     * 127.0.0.1 is Liberty's own admin surface.
     *
     * Asserted through the environment rather than by injecting a flag, because
     * the flag is exactly what this route must not let a source supply.
     */
    const loopback = () => ({
      status: "resolved" as const,
      candidates: fixtureCandidates(CONTENT_ID, "http://127.0.0.1:8096")
    });

    setNodeEnv("development");
    const local = await loadPlaybackSession(CONTENT_ID, loopback);
    expect(local.status).toBe("ok");

    setNodeEnv("production");
    const hosted = await loadPlaybackSession(CONTENT_ID, loopback);
    expect(hosted.status).toBe("denied");
    if (hosted.status !== "denied") return;
    expect(hosted.reasons.join(" ")).toContain("url_loopback_not_local_deployment");
  });
});

describe("outcomes", () => {
  it("hands the player candidates in the ranking's order, with its reasons", () => {
    return loadPlaybackSession(CONTENT_ID, resolving(ALSO_GOOD, GOOD)).then((result) => {
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      /* The 1080p/0.95-health candidate outranks the 480p/0.55 one, and the
       * order the source listed them in is not preserved — the ranking's is. */
      expect(result.session.candidates.map((entry) => entry.id)).toEqual(["good", "also-good"]);
      expect(result.session.contentId).toBe(CONTENT_ID);
      /* `null`, not `0`. For VOD that is the beginning and for live it is the
       * live edge, and PL-0403 is what will set it to a resume point. */
      expect(result.session.startAtSeconds).toBeNull();
      /* Product invariant 4 applies to a grant as much as to a denial. */
      expect(result.session.reasons.length).toBeGreaterThan(0);
      expect(result.policy.maxAttempts).toBeGreaterThan(0);
    });
  });

  it("distinguishes a title that does not exist from a provider that could not answer", () => {
    /* Different remedies. A reader told to "try again in a moment" about a
     * title that will never exist will keep trying. */
    return Promise.all([
      loadPlaybackSession(CONTENT_ID, () => ({ status: "not-found" })).then((result) => {
        expect(result.status).toBe("not-found");
      }),
      loadPlaybackSession(CONTENT_ID, () => {
        throw new Error("provider timed out");
      }).then((result) => {
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.reason).toBe("provider timed out");
      }),
      loadPlaybackSession(CONTENT_ID, () => ({
        status: "provider-unavailable",
        detail: "addon timed out"
      })).then((result) => {
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.reason).toBe("addon timed out");
      }),
      /* Resolved-but-empty is an outage, not a decision: nothing was refused,
       * so calling it `denied` would report a provider problem as a rights or
       * capability one. */
      loadPlaybackSession(CONTENT_ID, resolving()).then((result) => {
        expect(result.status).toBe("error");
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
    return loadPlaybackSession(
      CONTENT_ID,
      resolving(authorized({ id: "unlicensed", uri: "https://cdn.example.com/x.mpd", rights: unvetted }))
    ).then((result) => {
      expect(result.status).toBe("denied");
      if (result.status !== "denied") return;
      expect(result.reasons.join(" ")).toContain("rights_not_playable");
    });
  });

  it("drops a candidate whose source is not served over https, and says which", () => {
    /* The transport gate, run here so that a misconfigured origin is a reason on
     * the page rather than a generic network error three layers down that looks
     * exactly like a dead CDN.
     *
     * The expected text changed with the fix and the change is the improvement:
     * this used to assert the word "https" from `describeSourceRejection`, which
     * is the coarse three-value vocabulary of the checker that also accepted
     * `https://169.254.169.254/`. The named policy code is both more specific
     * and the one a reader can grep for in `url-policy.ts`. */
    return loadPlaybackSession(
      CONTENT_ID,
      resolving(authorized({ id: "insecure", uri: "http://cdn.example.com/insecure.mpd" }), GOOD)
    ).then((result) => {
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.session.candidates.map((entry) => entry.id)).toEqual(["good"]);
      expect(result.session.reasons.join(" ")).toContain("url_plaintext_http_not_loopback");
    });
  });

  it("denies rather than granting an empty session when nothing survives the checks", () => {
    /* A granted session with no candidates would send the player to `fatal`
     * with `no_candidates`, which is a true statement made in the wrong place:
     * the decision belongs to the layer that knows why. */
    return loadPlaybackSession(
      CONTENT_ID,
      resolving(authorized({ id: "insecure", uri: "http://cdn.example.com/insecure.mpd" }))
    ).then((result) => {
      expect(result.status).toBe("denied");
    });
  });

  it("uses the fixture source when none is injected", async () => {
    /*
     * The default path the route actually takes today, under a development or
     * test environment. It must produce a failover-capable list rather than a
     * single candidate, or the machine's whole reason for existing is untested
     * in the app.
     *
     * IN TWO HALVES, UNPINNED AND PINNED, because the two claims have different
     * dependencies and only one of them is this route's. `resolveAuthorizedCandidates`
     * reads `LIBERTY_FIXTURE_MEDIA_ORIGIN` at module scope, so an operator whose
     * rig is on `http://` or on a private host makes the default path refuse --
     * correctly, and now as `error` rather than `denied`, because the origin is
     * checked when the provider is constructed rather than when each candidate
     * is published. Requiring `ok` from the unpinned half would fail this test
     * for a reason it is not about, on that operator's machine only, which is
     * why every sibling here pins an origin instead.
     */

    /* Origin-independent, and the half that is actually about "none is
     * injected": the route reached the fixture provider through its own default
     * and got an answer that only the fixture path can produce. Neither
     * `not-configured` nor `not-found` can. */
    const byDefault = await loadPlaybackSession(CONTENT_ID);
    expect(["ok", "denied", "error"]).toContain(byDefault.status);

    /* The same provider, over an origin this file chose, so the failover and
     * transport properties are asserted against a rig no `.env.local` can
     * move. */
    const result = await loadPlaybackSession(CONTENT_ID, () => ({
      status: "resolved",
      candidates: fixtureCandidates(CONTENT_ID, "https://rig.test/media")
    }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session.candidates.length).toBeGreaterThan(1);
    for (const entry of result.session.candidates) {
      expect(entry.source.uri.startsWith("https://")).toBe(true);
    }
  });
});
