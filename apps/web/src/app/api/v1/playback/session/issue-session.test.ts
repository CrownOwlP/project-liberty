import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../../deployment-environment";
import {
  fixtureProvider,
  type AuthorizedCandidate,
  type AuthorizedCandidateResolution,
  type AuthorizedCandidateResolver
} from "./authorized-candidates";
import { playbackSessionRequestSchema, type PlaybackSessionResponse } from "./contract";
import { issuePlaybackSession, type IssueSessionOptions } from "./issue-session";

/*
 * What these pin is a BOUNDARY and an ORDER, not a set of fixtures: the request
 * carries an id and nothing that can become a URL, rights are settled before
 * any technical fact is compared, and every outcome -- including the ones a
 * client caused -- arrives with a reason trail.
 */

const CONTENT_ID = "aurora-fall";

/** Narrow on purpose, so eligibility is exercised rather than trivially passed. */
const CAPABILITIES = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

/**
 * The clock and the id generator are pinned rather than mocked globally. Both
 * are inputs to `issuePlaybackSession` precisely so a test can state them, and
 * `localDeployment: false` keeps these running as the hosted deployment does --
 * a suite that silently tested the permissive configuration would be testing
 * the one nobody ships.
 */
const FIXED: IssueSessionOptions = {
  now: () => new Date("2026-08-20T09:00:00.000Z"),
  newId: () => "fixed-id",
  localDeployment: false
};

function authorized(init: {
  id: string;
  uri?: string;
  rights?: ContentRights;
  height?: number | null;
  bitrateKbps?: number | null;
  videoCodec?: StreamCandidate["videoCodec"];
  audioCodec?: StreamCandidate["audioCodec"];
  estimatedLatencyMs?: number;
  healthScore?: number;
}): AuthorizedCandidate {
  const candidate: StreamCandidate = {
    id: init.id,
    providerId: "fixture",
    rights: init.rights ?? "owned",
    protocol: "dash",
    height: init.height === undefined ? 1080 : init.height,
    bitrateKbps: init.bitrateKbps === undefined ? 5000 : init.bitrateKbps,
    estimatedLatencyMs: init.estimatedLatencyMs ?? 80,
    healthScore: init.healthScore ?? 0.95,
    videoCodec: init.videoCodec === undefined ? "h264" : init.videoCodec,
    audioCodec: init.audioCodec === undefined ? "aac" : init.audioCodec
  };
  return {
    candidate,
    source: {
      uri: init.uri ?? `https://cdn.example.com/${init.id}/manifest.mpd`,
      mimeType: "application/dash+xml",
      allowLoopback: false
    }
  };
}

function resolving(candidates: readonly AuthorizedCandidate[]): AuthorizedCandidateResolver {
  return () => ({ status: "resolved", candidates });
}

function issue(
  candidates: readonly AuthorizedCandidate[],
  overrides: IssueSessionOptions = {}
): Promise<PlaybackSessionResponse> {
  return issuePlaybackSession(
    { contentId: CONTENT_ID, capabilities: CAPABILITIES },
    { ...FIXED, resolve: resolving(candidates), ...overrides }
  );
}

const GOOD = authorized({ id: "good" });
/* Worse in every scored dimension rather than in one, so this asserts that the
 * ranking's order is preserved rather than asserting the engine's weights --
 * which `@liberty/media-engine`'s own suite already owns. */
const ALSO_GOOD = authorized({
  id: "also-good",
  height: 480,
  bitrateKbps: 900,
  estimatedLatencyMs: 900,
  healthScore: 0.55
});

function codesFor(response: PlaybackSessionResponse, candidateId: string): string[] {
  return response.reasons.filter((entry) => entry.candidateId === candidateId).map((entry) => entry.code);
}

describe("what the endpoint will not accept", () => {
  it("exposes no request field through which a caller could name a media URL", () => {
    /*
     * Asserted structurally rather than by probing strings. A session endpoint
     * that plays what the caller asked for is an open proxy for arbitrary
     * media, and it relocates product invariant 1 into whoever populated the
     * field -- so the ABSENCE of such a field is the enforcement, and this is
     * what fails if somebody adds one.
     */
    expect(Object.keys(playbackSessionRequestSchema.shape).sort()).toEqual([
      "capabilities",
      "contentId"
    ]);
  });

  it("refuses a request carrying an unaccepted field, before consulting any resolver", async () => {
    let calls = 0;
    const resolve: AuthorizedCandidateResolver = () => {
      calls += 1;
      return { status: "resolved", candidates: [GOOD] };
    };

    const response = await issuePlaybackSession(
      {
        contentId: CONTENT_ID,
        capabilities: CAPABILITIES,
        uri: "https://elsewhere.test/anything.mpd",
        candidates: [{ id: "smuggled" }]
      },
      { ...FIXED, resolve }
    );

    expect(response.outcome).toBe("denied");
    /* The smuggled field speaks FIRST, so the rights-boundary refusal is the
     * primary reason rather than a line buried under a schema complaint. */
    expect(response.reasons[0].code).toBe("request_field_not_permitted");
    expect(response.reasons[0].detail).toContain("uri");
    expect(response.reasons[0].detail).toContain("candidates");
    /* Nothing the client sent reached the provider boundary. */
    expect(calls).toBe(0);
  });

  it("refuses a capability object carrying an unaccepted field", async () => {
    const response = await issuePlaybackSession(
      {
        contentId: CONTENT_ID,
        capabilities: { ...CAPABILITIES, manifestUri: "https://elsewhere.test/x.m3u8" }
      },
      { ...FIXED, resolve: resolving([GOOD]) }
    );

    expect(response.outcome).toBe("denied");
    expect(response.reasons[0].code).toBe("request_field_not_permitted");
    expect(response.reasons[0].detail).toContain("manifestUri");
  });

  it("answers malformed input with a well-formed denial instead of throwing", async () => {
    /* Every one of these is something a real client has sent to a real API. A
     * throw here would be a 500 with no reason trail, which invariant 4 forbids
     * exactly as much as a silent denial does. */
    const malformed: unknown[] = [
      null,
      undefined,
      7,
      "aurora-fall",
      [],
      {},
      { contentId: CONTENT_ID },
      { contentId: CONTENT_ID, capabilities: {} },
      { contentId: "AURORA-FALL", capabilities: CAPABILITIES },
      { contentId: "../secret", capabilities: CAPABILITIES },
      { contentId: "", capabilities: CAPABILITIES },
      { contentId: "https://elsewhere.test/x.mpd", capabilities: CAPABILITIES }
    ];

    for (const [index, body] of malformed.entries()) {
      const response = await issuePlaybackSession(body, { ...FIXED, resolve: resolving([GOOD]) });
      expect(response.outcome, `malformed input #${index}`).toBe("denied");
      expect(response.reasons.length, `malformed input #${index}`).toBeGreaterThan(0);
    }
  });
});

describe("rights come first", () => {
  it("denies a title whose only candidate carries a rights basis we may not play from", async () => {
    /*
     * The cast is the point and it is not laziness -- the same reasoning
     * `unvettedRightsArb` in `@liberty/contracts` is built on. Every member of
     * `ContentRights` is currently on the playable allowlist, so with only
     * well-typed values this guarantee is VACUOUS and no test can observe it.
     * The string stands in for the rights value somebody adds to the enum next
     * quarter without touching the allowlist.
     */
    const unvetted = "rights-unknown" as unknown as ContentRights;
    const response = await issue([authorized({ id: "unlicensed", rights: unvetted })]);

    expect(response.outcome).toBe("denied");
    expect(response.reasons[0].code).toBe("rights_not_established");
    expect(codesFor(response, "unlicensed")).toEqual(["rights_not_playable"]);
  });

  it("settles rights before it compares a single technical fact", async () => {
    /*
     * This candidate would fail EVERY technical check as well: a codec the
     * device did not list, a height above its ceiling, a health score under the
     * floor. If rights were evaluated anywhere but first, at least one of those
     * would appear in its trail -- and a viewer would be told their device was
     * the problem when the real answer is that we have no right to serve it.
     */
    const unvetted = "expired" as unknown as ContentRights;
    const response = await issue([
      authorized({
        id: "unlicensed",
        rights: unvetted,
        videoCodec: "av1",
        audioCodec: "opus",
        height: 4320,
        healthScore: 0.05
      })
    ]);

    expect(codesFor(response, "unlicensed")).toEqual(["rights_not_playable"]);
  });

  it("reports a rights refusal as one even when the resolver sent the candidate twice", async () => {
    /*
     * The identity gate used to run BEFORE the rights gate, so two copies of an
     * unrightsed candidate were both dropped as `duplicate_candidate_id` and the
     * rights refusal was never reported at all -- the one line a rights review
     * reads, replaced by a resolver-hygiene notice about the same drop. The
     * property suite cannot see this: `unvettedRightsCandidatesArb` produces
     * distinct ids only, so the two gates never compete there.
     *
     * The second half of the assertion is the reason the rights gate collects by
     * id rather than per entry: a repeated id must produce ONE line, or
     * "an unrightsed candidate carries exactly one reason" would hold only for
     * resolvers that never repeat themselves.
     */
    const unvetted = "rights-unknown" as unknown as ContentRights;
    const response = await issue([
      authorized({ id: "twin", rights: unvetted, healthScore: 0.6 }),
      authorized({ id: "twin", rights: unvetted, healthScore: 0.99 }),
      GOOD
    ]);

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    expect(response.session.candidates.map((entry) => entry.id)).toEqual(["good"]);
    expect(codesFor(response, "twin")).toEqual(["rights_not_playable"]);
  });

  it("drops only the unrightsed candidate when a rightsed one exists", async () => {
    const unvetted = "unlicensed" as unknown as ContentRights;
    const response = await issue([authorized({ id: "bad", rights: unvetted }), GOOD]);

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    expect(response.session.candidates.map((entry) => entry.id)).toEqual(["good"]);
    expect(codesFor(response, "bad")).toEqual(["rights_not_playable"]);
  });
});

describe("outcomes", () => {
  it("grants a session in the ranking's order, with a trail on the grant", async () => {
    const response = await issue([ALSO_GOOD, GOOD]);

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;

    /* The order the resolver listed them in is not preserved -- the ranking's
     * is. */
    expect(response.session.candidates.map((entry) => entry.id)).toEqual(["good", "also-good"]);
    expect(response.session.contentId).toBe(CONTENT_ID);
    /* `null`, not `0`: engine default. PL-0403 is what will set a resume point. */
    expect(response.session.startAtSeconds).toBeNull();
    expect(response.session.expiresAt).toBe("2026-08-20T09:05:00.000Z");
    expect(response.session.failoverPolicy.maxAttempts).toBeGreaterThan(0);
    /* Invariant 4 applies to a grant as much as to a denial. */
    expect(response.reasons.length).toBeGreaterThan(0);
    expect(response.reasons[0].code).toBe("session_issued");
  });

  it("carries reasons on every branch it can produce", async () => {
    const unvetted = "rights-unknown" as unknown as ContentRights;
    const cases: Array<{ label: string; response: PlaybackSessionResponse }> = [
      { label: "granted", response: await issue([GOOD]) },
      { label: "denied/rights", response: await issue([authorized({ id: "x", rights: unvetted })]) },
      { label: "denied/malformed", response: await issuePlaybackSession(null, FIXED) },
      { label: "unavailable/empty", response: await issue([]) },
      {
        label: "unavailable/not-found",
        response: await issue([], { resolve: () => ({ status: "not-found" }) })
      },
      {
        label: "unavailable/not-configured",
        response: await issue([], { resolve: () => ({ status: "not-configured" }) })
      },
      {
        label: "unavailable/provider",
        response: await issue([], {
          resolve: () => ({ status: "provider-unavailable", detail: "addon timed out" })
        })
      },
      {
        label: "unavailable/throw",
        response: await issue([], {
          resolve: () => {
            throw new Error("socket hang up");
          }
        })
      },
      {
        label: "unavailable/nothing playable",
        response: await issue([authorized({ id: "too-tall", height: 4320 })])
      }
    ];

    for (const entry of cases) {
      expect(entry.response.reasons.length, entry.label).toBeGreaterThan(0);
      for (const reason of entry.response.reasons) {
        expect(reason.detail.length, `${entry.label}/${reason.code}`).toBeGreaterThan(0);
      }
    }

    expect(cases.map((entry) => entry.response.outcome)).toEqual([
      "granted",
      "denied",
      "denied",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable"
    ]);
  });

  it("does not echo a thrown resolver error into the response", async () => {
    /* A resolver's exception text is whatever some library felt like saying,
     * and it has carried hostnames, query strings and credentials before. The
     * `provider-unavailable` branch publishes a detail the resolver CHOSE; a
     * throw chose nothing. */
    const response = await issue([], {
      resolve: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:9200");
      }
    });

    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].code).toBe("provider_unavailable");
    expect(response.reasons[0].detail).not.toContain("10.0.0.7");
  });

  it("never grants a session with no candidates", async () => {
    /* A grant with an empty list sends the player straight to `fatal` with
     * `no_candidates`: a true statement made by the layer that does not know
     * why. The decision belongs here, with the reasons. */
    const response = await issue([authorized({ id: "too-tall", height: 4320 })]);

    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].code).toBe("no_playable_candidate");
    expect(codesFor(response, "too-tall")).toEqual(["resolution_exceeds_capability"]);
  });

  it("drops a candidate whose source is not fetchable over https, and says which", async () => {
    const response = await issue([
      authorized({ id: "plaintext", uri: "http://cdn.example.com/plaintext.mpd" }),
      authorized({ id: "internal", uri: "https://10.0.0.5/internal.mpd" }),
      authorized({ id: "magnet", uri: "magnet:?xt=urn:btih:0000" }),
      GOOD
    ]);

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    expect(response.session.candidates.map((entry) => entry.id)).toEqual(["good"]);
    expect(codesFor(response, "plaintext")).toEqual(["url_plaintext_http_not_loopback"]);
    expect(codesFor(response, "internal")).toEqual(["url_private_address"]);
    expect(codesFor(response, "magnet")).toEqual(["url_scheme_not_http"]);
  });

  it("drops every candidate sharing an id, so a reported failure is always attributable", async () => {
    const response = await issue([
      authorized({ id: "twin", healthScore: 0.6 }),
      authorized({ id: "twin", healthScore: 0.99 }),
      authorized({ id: "solo" })
    ]);

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    expect(response.session.candidates.map((entry) => entry.id)).toEqual(["solo"]);
    expect(codesFor(response, "twin")).toEqual(["duplicate_candidate_id"]);
  });

  it("publishes the fixture candidates over https when the dev resolver is used", async () => {
    /*
     * The origin is pinned rather than read from the environment: a test whose
     * expectations depend on somebody's `.env.local` passes on one machine and
     * fails on another.
     *
     * The provider is reached through a witness because there is no other way to
     * reach it -- `fixtureProvider` takes a `NonDeploymentEnvironment`, which
     * only `deployment-environment.ts` can mint and only for an environment on
     * its allowlist. `test` is the one vitest sets, and the non-null assertion
     * is written as a throw so a failure here reads as "the allowlist changed"
     * rather than as a `TypeError` inside the fixture builder.
     */
    const environment = NonDeploymentEnvironment.classify("test");
    if (environment === null) throw new Error("`test` is no longer a non-deployment environment");

    const response = await issue(
      fixtureProvider(environment).candidates(CONTENT_ID, "https://fixtures.invalid")
    );

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    /* More than one, or the failover machine's whole reason for existing is
     * untested in the app. */
    expect(response.session.candidates.length).toBe(3);
    for (const entry of response.session.candidates) {
      expect(entry.uri.startsWith("https://fixtures.invalid/")).toBe(true);
    }
  });
});

describe("determinism", () => {
  it("produces an identical response for a reversed resolver output", async () => {
    const candidates = [GOOD, ALSO_GOOD, authorized({ id: "third", healthScore: 0.7 })];

    const forward = await issue(candidates);
    const backward = await issue([...candidates].reverse());

    /* The WHOLE response, not just the candidate order: the reason trail is
     * part of the contract and a trail that reorders is a diff nobody can
     * review. */
    expect(backward).toEqual(forward);
  });

  it("keeps the trail stable when candidates are dropped for different reasons", async () => {
    const unvetted = "rights-unknown" as unknown as ContentRights;
    const mixed: readonly AuthorizedCandidate[] = [
      GOOD,
      authorized({ id: "unrightsed", rights: unvetted }),
      authorized({ id: "too-tall", height: 4320 }),
      authorized({ id: "plaintext", uri: "http://cdn.example.com/x.mpd" })
    ];

    const forward = await issue(mixed);
    const backward = await issue([...mixed].reverse());

    expect(backward).toEqual(forward);
  });
});

describe("the resolver seam", () => {
  it("is handed a normalized content id and a server-generated request id, and nothing else", async () => {
    /*
     * The resolver's whole input surface, recorded. A correlation id read from
     * an inbound header would be a client-chosen value in a third party's logs,
     * so the one here is generated on this side -- which is why it is the
     * injected generator's output and not something from the request.
     */
    const seen: Array<{ contentId: string; requestId: string }> = [];
    const resolve: AuthorizedCandidateResolver = (contentId, context) => {
      seen.push({ contentId, requestId: context.requestId });
      const resolution: AuthorizedCandidateResolution = { status: "resolved", candidates: [GOOD] };
      return resolution;
    };

    await issuePlaybackSession(
      { contentId: CONTENT_ID, capabilities: CAPABILITIES },
      { ...FIXED, resolve }
    );

    expect(seen).toEqual([{ contentId: CONTENT_ID, requestId: "fixed-id" }]);
  });
});
