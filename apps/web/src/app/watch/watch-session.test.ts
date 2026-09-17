import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FAILOVER_POLICY } from "@liberty/media-engine";
import { PROTECTION_NOT_STATED } from "@liberty/contracts/shared/drm";
import { describe, expect, it } from "vitest";
import {
  deniedSession,
  grantedSession,
  playbackReason,
  playbackSessionHttpStatus,
  playbackSessionRequestSchema,
  playbackSessionReasonCodeSchema,
  unavailableSession,
  type IssuedPlaybackSession,
  type PlaybackSessionCandidate,
  type PlaybackSessionReasonCode,
  type PlaybackSessionResponse
} from "../api/v1/playback/session/contract";
import { playbackSessionResponse } from "../api/v1/playback/session/handler";
import {
  CONSERVATIVE_CAPABILITIES,
  PLAYBACK_SESSION_ROUTE,
  describeReason,
  isWatchableContentId,
  loadPlaybackSession,
  watchResultFor,
  type PlaybackSessionIssuer
} from "./watch-session";

/* -------------------------------------------------------------------------
 * WHAT THIS FILE TESTS NOW, AND WHY IT IS A DIFFERENT FILE FROM THE ONE IT
 * REPLACES (PL-0501, round 45, correction 1)
 *
 * Until this round `watch-session.ts` imported `resolveAuthorizedCandidates`
 * and ran the rights gate, `rankStreamCandidates` and `checkUrl` IN THE PAGE,
 * and this suite tested all three of those through it: where the fixture path
 * may run, what the fixtures contain, the transport gate, the rights refusal.
 * Those assertions have NOT been weakened or dropped -- the behaviour moved
 * behind `POST /api/v1/playback/session`, and it is asserted there, against the
 * code that now performs it:
 *
 *   - the fixture environment gate and what a fixture may claim:
 *     `../api/v1/playback/session/authorized-candidates.test.ts`;
 *   - the six gates in order, rights before identity, the ranking, the
 *     outbound `checkUrl` pass and the TTL bound:
 *     `../api/v1/playback/session/issue-session.test.ts` and
 *     `issue-session.property.test.ts`;
 *   - the HTTP envelope, the statuses and `no-store`:
 *     `../api/v1/playback/session/handler.test.ts`;
 *   - that the forwarder reaches a real backend and that the two targets agree:
 *     `e2e/tests/playback-session.desktop.api.spec.ts` and
 *     `e2e/tests/playback-session.cross-target.api.spec.ts`.
 *
 * A copy of those assertions here would be a second place to update, and --
 * worse -- it would only be writable by importing the resolver into this
 * module's graph again, which is the exposure the correction removes.
 *
 * WHAT IS LEFT FOR THIS FILE IS EXACTLY WHAT THIS MODULE STILL DECIDES: the
 * identity pre-filter, the request it sends, the mapping from the wire union
 * onto the five panels the page renders, the client-predictive backstop, and
 * the structural property that the default path really is the route rather than
 * something that resembles it.
 * ---------------------------------------------------------------------- */

const CONTENT_ID = "aurora-fall";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_WEB = resolve(HERE, "../../..");

function candidate(overrides: Partial<PlaybackSessionCandidate> = {}): PlaybackSessionCandidate {
  return {
    id: `${CONTENT_ID}-hls`,
    providerId: "fixture",
    uri: `https://fixtures.invalid/${CONTENT_ID}/master.m3u8`,
    mimeType: "application/vnd.apple.mpegurl",
    compatibility: "unverified",
    protection: PROTECTION_NOT_STATED,
    ...overrides
  };
}

function issued(overrides: Partial<IssuedPlaybackSession> = {}): IssuedPlaybackSession {
  return {
    sessionId: "session-1",
    contentId: CONTENT_ID,
    candidates: [candidate()],
    startAtSeconds: null,
    expiresAt: new Date("2026-09-17T00:05:00.000Z").toISOString(),
    failoverPolicy: DEFAULT_FAILOVER_POLICY,
    ...overrides
  };
}

/**
 * An issuer that answers with a response of this suite's choosing, THROUGH THE
 * ROUTE'S OWN ENVELOPE.
 *
 * `playbackSessionResponse` is the function `handler.ts` uses, so what this
 * loader reads back is a real `Response` with the real status, the real
 * `no-store` header and a body that passed the real schema check. A hand-rolled
 * `Response.json(...)` here would let a test assert against a body the route
 * could not actually produce.
 */
function answering(response: PlaybackSessionResponse): {
  issue: PlaybackSessionIssuer;
  seen: Request[];
} {
  const seen: Request[] = [];
  return {
    seen,
    issue: async (request) => {
      seen.push(request);
      return playbackSessionResponse(response);
    }
  };
}

describe("what the route will not accept", () => {
  it("answers not-found for an id that could never name anything", async () => {
    for (const contentId of ["../../etc/passwd", "Aurora Fall", "https://evil.test/x.mpd", ""]) {
      expect(isWatchableContentId(contentId), contentId).toBe(false);

      const { issue, seen } = answering(
        grantedSession(issued(), playbackReason("session_issued", "should never be reached"))
      );
      const result = await loadPlaybackSession(contentId, {}, issue);

      expect(result.status, contentId).toBe("not-found");
      /* AND THE BOUNDARY WAS NEVER CROSSED. The route would refuse the same id
       * -- both sides read `normalizedContentIdSchema` -- but raw URL path
       * input should not reach the trust boundary at all, and under the desktop
       * target reaching it means a network call to the backend. */
      expect(seen, contentId).toHaveLength(0);
    }
  });

  it("takes no argument through which a caller could supply a media URL", () => {
    /*
     * The signature is the boundary. `loadPlaybackSession(contentId, context,
     * issue)`: a content id, a header bag that is forwarded and never read, and
     * a test seam. Nothing here accepts a URI, and the request it builds is
     * validated below against the route's own `.strict()` schema, which would
     * refuse one anyway.
     */
    expect(loadPlaybackSession.length).toBe(1);
  });

  it("sends a request the route's own schema accepts, and nothing more", async () => {
    const { issue, seen } = answering(
      grantedSession(issued(), playbackReason("session_issued", "granted"))
    );
    await loadPlaybackSession(CONTENT_ID, {}, issue);

    expect(seen).toHaveLength(1);
    const request = seen[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(PLAYBACK_SESSION_ROUTE);

    const body: unknown = JSON.parse(await request.text());
    /*
     * `.strict()` AT BOTH LEVELS IS THE ASSERTION. The schema refuses an
     * unknown key rather than stripping it, so parsing the page's own body with
     * it proves the page sends exactly `contentId` and `capabilities` -- no
     * URI, no rights claim, no candidate list, and no field a later edit added
     * without thinking about what the server would do with it.
     */
    const parsed = playbackSessionRequestSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(body)).toBe(true);
    expect(body).toEqual({ contentId: CONTENT_ID, capabilities: CONSERVATIVE_CAPABILITIES });
  });

  it("forwards the caller's headers without reading or filtering them", async () => {
    /*
     * §8: the desktop proxy "forwards an authenticated caller identity -- the
     * session or profile identity the request already carries". The page hands
     * its inbound headers down; the FORWARDER's allowlist decides what leaves
     * the machine. A second, quieter allowlist here is what this asserts the
     * absence of -- including for a header nobody has invented yet.
     */
    const { issue, seen } = answering(
      grantedSession(issued(), playbackReason("session_issued", "granted"))
    );
    const headers = new Headers({
      cookie: "liberty_session=abc",
      "x-liberty-development-account": "viewer-1",
      "x-not-yet-invented": "carried"
    });
    await loadPlaybackSession(CONTENT_ID, { headers }, issue);

    const request = seen[0] as Request;
    expect(request.headers.get("cookie")).toBe("liberty_session=abc");
    expect(request.headers.get("x-liberty-development-account")).toBe("viewer-1");
    expect(request.headers.get("x-not-yet-invented")).toBe("carried");
    expect(request.headers.get("content-type")).toBe("application/json");
  });
});

describe("the decision, mapped onto what the page renders", () => {
  it("renders a granted session in the order the session published", async () => {
    const first = candidate({ id: "a", uri: "https://fixtures.invalid/a.m3u8" });
    const second = candidate({ id: "b", uri: "https://fixtures.invalid/b.mpd", mimeType: null });
    const response = grantedSession(
      issued({ candidates: [first, second], startAtSeconds: 42 }),
      playbackReason("session_issued_unverified_compatibility", "two candidates"),
      playbackReason("candidate_ranked", "scored", "a")
    );

    const { issue } = answering(response);
    const result = await loadPlaybackSession(CONTENT_ID, {}, issue);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session.candidates.map((entry) => entry.id)).toEqual(["a", "b"]);
    /* An empty `Content-Type` is `undefined` to `PlaybackSource`, never `""`:
     * Shaka issues a HEAD request to guess when it is absent, and a blank
     * string would make it guess while believing it had been told. */
    expect(result.session.candidates[1]?.source.mimeType).toBeUndefined();
    expect(result.session.startAtSeconds).toBe(42);
    /* The policy is the SESSION's, not a constant this page holds. */
    expect(result.policy).toEqual(DEFAULT_FAILOVER_POLICY);
    expect(result.session.reasons).toEqual(response.reasons.map(describeReason));
  });

  it("denies rather than granting an empty session when the backstop drops everything", async () => {
    /*
     * `checkPlaybackSource` is narrower than the server's `checkUrl` -- it
     * admits `localhost`, `127.0.0.1` and `[::1]` and nothing else on plaintext
     * http -- so a candidate the server legitimately published can still fail
     * here. A player handed an empty list goes straight to `fatal` with
     * `no_candidates`, a true statement made by the layer that does not know
     * why, so the panel says it instead and carries the reason.
     */
    const response = grantedSession(
      issued({ candidates: [candidate({ uri: "http://127.0.0.2:8096/x.m3u8" })] }),
      playbackReason("session_issued", "granted by the server")
    );

    const { issue } = answering(response);
    const result = await loadPlaybackSession(CONTENT_ID, {}, issue);

    expect(result.status).toBe("denied");
    if (result.status !== "denied") return;
    expect(result.reasons.some((reason) => reason.includes("not served over https"))).toBe(
      true
    );
  });

  it("can only remove a candidate, never add one", () => {
    /*
     * The structural half of the sentence above. Whatever the backstop does,
     * the rendered list is a SUBSEQUENCE of the session's -- same ids, same
     * order, nothing invented. This is the property that would catch a future
     * edit that "helpfully" synthesised a fallback source in the page.
     */
    const ids = ["a", "b", "c"];
    const response = grantedSession(
      issued({
        candidates: [
          candidate({ id: "a", uri: "https://fixtures.invalid/a.m3u8" }),
          candidate({ id: "b", uri: "http://127.0.0.2:8096/b.m3u8" }),
          candidate({ id: "c", uri: "https://fixtures.invalid/c.mpd" })
        ]
      }),
      playbackReason("session_issued", "three candidates")
    );

    const result = watchResultFor(CONTENT_ID, response);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const rendered = result.session.candidates.map((entry) => entry.id);
    expect(rendered).toEqual(rendered.filter((id) => ids.includes(id)));
    expect(rendered).toEqual(["a", "c"]);
  });

  it("splits unavailable three ways, by remedy", () => {
    /*
     * THE SPLIT IS THE WHOLE REASON THIS MAPPING EXISTS. A viewer told "try
     * again in a moment" about a deployment with no provider configured will
     * keep trying, and one told "we could not find that title" about a CDN blip
     * will stop. The wire union does not make this distinction for the page --
     * all three are `unavailable` -- so the page makes it from the PRIMARY
     * reason code, which is the field the contract designates for it.
     */
    expect(
      watchResultFor(
        CONTENT_ID,
        unavailableSession(playbackReason("content_not_found", "nothing registered"))
      ).status
    ).toBe("not-found");

    expect(
      watchResultFor(
        CONTENT_ID,
        unavailableSession(playbackReason("provider_not_configured", "no provider"))
      ).status
    ).toBe("not-configured");

    expect(
      watchResultFor(
        CONTENT_ID,
        unavailableSession(playbackReason("provider_unavailable", "the backend is down"))
      ).status
    ).toBe("error");
  });

  it("renders a denial as a denial, with the whole trail", () => {
    const response = deniedSession(
      playbackReason("rights_not_established", "no candidate carries a playable basis"),
      playbackReason("rights_not_playable", "basis unstated", "a")
    );
    const result = watchResultFor(CONTENT_ID, response);

    expect(result.status).toBe("denied");
    if (result.status !== "denied") return;
    expect(result.reasons).toHaveLength(2);
    /* The candidate attribution survives the crossing. A trail that lost which
     * stream a refusal was about is a trail nobody can act on. */
    expect(result.reasons[1]).toContain("a:");
    expect(result.reasons[1]).toContain("rights_not_playable");
  });

  it("has an answer for every reason code the contract can produce", () => {
    /*
     * EXHAUSTIVE OVER THE VOCABULARY rather than over the cases somebody
     * thought of. A new reason code added to `contract.ts` that this mapping
     * handles badly shows up here on the day it is added -- which is the same
     * discipline `engineReasonCode` applies to the engine's vocabulary at
     * compile time.
     *
     * Every code is driven through BOTH refusal branches, because a code's
     * outcome is the server's choice and this page must not assume which branch
     * a given code arrives on.
     */
    const codes = playbackSessionReasonCodeSchema.options as readonly PlaybackSessionReasonCode[];
    expect(codes.length).toBeGreaterThan(20);

    for (const code of codes) {
      const denied = watchResultFor(CONTENT_ID, deniedSession(playbackReason(code, "detail")));
      expect(denied.status, `denied/${code}`).toBe("denied");

      const unavailable = watchResultFor(
        CONTENT_ID,
        unavailableSession(playbackReason(code, "detail"))
      );
      expect(
        ["not-found", "not-configured", "error"],
        `unavailable/${code}`
      ).toContain(unavailable.status);

      /* No branch is ever reason-less; product invariant 4 applies to the panel
       * exactly as it applies to the wire. */
      if (unavailable.status === "error") expect(unavailable.reason).toContain(code);
      if (denied.status === "denied") expect(denied.reasons.join("\n")).toContain(code);
    }
  });

  it("turns a body outside the contract into an honest error rather than a crash", async () => {
    /*
     * The 500 `handler.ts` emits for its own self-check failure is deliberately
     * NOT a member of the union, so it lands here. A page that cast the body
     * would render `undefined` into the player; this one says what happened.
     */
    const issue: PlaybackSessionIssuer = async () =>
      Response.json({ error: "playback_session_failed_validation" }, { status: 500 });

    const result = await loadPlaybackSession(CONTENT_ID, {}, issue);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toContain("outside the playback session contract");
  });

  it("never throws, even when the route does", async () => {
    const issue: PlaybackSessionIssuer = async () => {
      throw new Error("the route exploded");
    };
    const result = await loadPlaybackSession(CONTENT_ID, {}, issue);
    expect(result.status).toBe("error");
  });

  it("agrees with the wire status about what each outcome means", () => {
    /*
     * A cross-check rather than a restatement: the page's five panels and the
     * route's HTTP statuses are two readings of one decision, and they must not
     * disagree about which decisions are refusals. 200 is the only status that
     * may reach a player.
     */
    const cases: readonly PlaybackSessionResponse[] = [
      grantedSession(issued(), playbackReason("session_issued", "ok")),
      deniedSession(playbackReason("request_malformed", "bad")),
      deniedSession(playbackReason("rights_not_established", "no basis")),
      unavailableSession(playbackReason("content_not_found", "missing")),
      unavailableSession(playbackReason("provider_not_configured", "unconfigured")),
      unavailableSession(playbackReason("provider_unavailable", "down"))
    ];

    for (const response of cases) {
      const status = playbackSessionHttpStatus(response);
      const result = watchResultFor(CONTENT_ID, response);
      expect(result.status === "ok", `${response.outcome}/${status}`).toBe(status === 200);
    }
  });
});

describe("the default path is the target-selected route, structurally", () => {
  /* -------------------------------------------------------------------------
   * THE CORRECTION'S ACTUAL SUBJECT. It is not enough that this module produces
   * the right panels: it must obtain them from the module that sits in front of
   * the build-target seam, so that a DESKTOP build resolves the forwarder and
   * never compiles a provider resolver into the watch path.
   *
   * The module-graph proof is `../api/v1/playback/build-target.test.ts`, which
   * now walks every app entry point under the desktop resolution rules and
   * requires an EMPTY offender list. What is asserted here is the source-level
   * half that a graph walk cannot state as sharply: which module this one asks,
   * and which ones it no longer names at all.
   * ---------------------------------------------------------------------- */

  const source = readFileSync(join(HERE, "watch-session.ts"), "utf8");

  it("imports the session handler and nothing from a resolver", () => {
    const importLines = source
      .split("\n")
      .filter((line) => /\bfrom\s*"/.test(line) && !line.trimStart().startsWith("*"));
    const specifiers = importLines.map((line) => (/from\s*"([^"]+)"/.exec(line) ?? [])[1] ?? "");

    expect(specifiers).toContain("../api/v1/playback/session/handler");

    /* The four things this file used to reach, and must not again. The
     * `.desktop` half is on the list too: naming it here would pull the
     * forwarder into the WEB build's graph and defeat the split from the other
     * side. */
    for (const forbidden of [
      "@liberty/provider-sdk",
      "@liberty/media-engine",
      "../api/v1/playback/session/authorized-candidates",
      "../api/v1/playback/session/issue-session",
      "../api/v1/playback/session/playback-session-implementation",
      "../api/v1/playback/session/playback-session-implementation.desktop"
    ]) {
      expect(specifiers, `watch-session.ts imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("names the route path the route module actually sits at", () => {
    /*
     * The path is restated in this module rather than imported, for the reason
     * the module gives: importing it from either half of the seam would drag
     * that half into the other target's graph. So it is pinned against the
     * `app/` tree instead -- a route at `app/api/v1/playback/session/route.ts`
     * is served at `/api/v1/playback/session`, and a move would break this.
     */
    const routeFile = join(
      APP_WEB,
      "src/app",
      `${PLAYBACK_SESSION_ROUTE.replace(/^\//, "")}/route.ts`
    );
    expect(() => readFileSync(routeFile, "utf8")).not.toThrow();
  });

  it("uses the handler when no issuer is injected", async () => {
    /*
     * THE DEFAULT ARGUMENT IS THE PRODUCTION PATH, so it is exercised rather
     * than assumed. Under vitest `NODE_ENV` is `test`, which
     * `authorized-candidates.ts` admits as a non-deployment environment, so the
     * real resolving implementation answers with the fixture provider's
     * candidates -- an outcome this suite does not pin, because it belongs to
     * the session API's own tests. What is pinned is that a real decision came
     * back, with a trail, and that nothing threw.
     */
    const result = await loadPlaybackSession(CONTENT_ID);
    expect(["ok", "denied", "not-configured", "not-found", "error"]).toContain(result.status);
    if (result.status === "ok") {
      expect(result.session.reasons.length).toBeGreaterThan(0);
      expect(result.session.candidates.length).toBeGreaterThan(0);
    }
  });
});
