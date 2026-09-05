import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { describe, expect, it } from "vitest";
import type { AuthorizedCandidate, AuthorizedCandidateResolver } from "./authorized-candidates";
import { playbackSessionResponseSchema, type PlaybackSessionResponse } from "./contract";
import { handlePlaybackSessionRequest } from "./handler";
import type { IssueSessionOptions } from "./issue-session";
import { POST } from "./route";

/*
 * The HTTP half. What is pinned here is that the status code and the outcome
 * never disagree, that a client-caused failure is a client-status answer rather
 * than a 500, and that every body on the wire is a member of the published
 * union -- so a caller can parse one shape and get a decision plus its reasons,
 * whatever went wrong.
 */

const CAPABILITIES = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

const FIXED: IssueSessionOptions = {
  now: () => new Date("2026-08-20T09:00:00.000Z"),
  newId: () => "fixed-id",
  localDeployment: false
};

const CANDIDATE: StreamCandidate = {
  id: "aurora-fall-dash",
  providerId: "fixture",
  rights: "owned",
  protocol: "dash",
  height: 1080,
  bitrateKbps: 5000,
  estimatedLatencyMs: 80,
  healthScore: 0.95,
  videoCodec: "h264",
  audioCodec: "aac"
};

function authorizedWith(rights: ContentRights): AuthorizedCandidate {
  return {
    candidate: { ...CANDIDATE, rights },
    source: {
      uri: "https://cdn.example.com/aurora-fall/manifest.mpd",
      mimeType: "application/dash+xml",
      allowLoopback: false
    }
  };
}

function resolving(candidates: readonly AuthorizedCandidate[]): AuthorizedCandidateResolver {
  return () => ({ status: "resolved", candidates });
}

function post(body: string): Request {
  return new Request("https://liberty.test/api/v1/playback/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
}

function postJson(body: unknown): Request {
  return post(JSON.stringify(body));
}

async function decision(response: Response): Promise<PlaybackSessionResponse> {
  /* Parsed against the published contract rather than read as `any`: a body
   * that is not a member of the union is a contract break, and it should fail
   * the test here rather than three assertions later as a missing property. */
  return playbackSessionResponseSchema.parse(await response.json());
}

describe("status codes follow the decision", () => {
  it("answers a body that is not JSON with a denial rather than a 500", async () => {
    /* `request.json()` throws on this. Letting it propagate would turn the most
     * trivial client bug into a server error carrying no reason trail. */
    const response = await handlePlaybackSessionRequest(post("{not json"), {
      ...FIXED,
      resolve: resolving([authorizedWith("owned")])
    });

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.outcome).toBe("denied");
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("answers a request carrying an unaccepted field with 400 and names the field", async () => {
    const response = await handlePlaybackSessionRequest(
      postJson({
        contentId: "aurora-fall",
        capabilities: CAPABILITIES,
        uri: "https://elsewhere.test/x.mpd"
      }),
      { ...FIXED, resolve: resolving([authorizedWith("owned")]) }
    );

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.outcome).toBe("denied");
    expect(body.reasons[0].code).toBe("request_field_not_permitted");
    expect(body.reasons[0].detail).toContain("uri");
  });

  it("answers a rights refusal with 403 rather than 400 or 404", async () => {
    /* A rights denial is the signal a rights review reads out of the access
     * logs, so it has to be distinguishable from a client typo (400) and from a
     * title that does not exist (404). */
    const unvetted = "rights-unknown" as unknown as ContentRights;
    const response = await handlePlaybackSessionRequest(
      postJson({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      { ...FIXED, resolve: resolving([authorizedWith(unvetted)]) }
    );

    expect(response.status).toBe(403);
    const body = await decision(response);
    expect(body.outcome).toBe("denied");
    expect(body.reasons[0].code).toBe("rights_not_established");
  });

  it("answers an unknown id with 404 and an unavailable provider with 503", async () => {
    const missing = await handlePlaybackSessionRequest(
      postJson({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      { ...FIXED, resolve: () => ({ status: "not-found" }) }
    );
    expect(missing.status).toBe(404);
    expect((await decision(missing)).outcome).toBe("unavailable");

    const down = await handlePlaybackSessionRequest(
      postJson({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      { ...FIXED, resolve: () => ({ status: "provider-unavailable", detail: "addon timed out" }) }
    );
    expect(down.status).toBe(503);
    expect((await decision(down)).outcome).toBe("unavailable");
  });

  it("answers a grant with 200, the session, and no-store", async () => {
    const response = await handlePlaybackSessionRequest(
      postJson({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      { ...FIXED, resolve: resolving([authorizedWith("owned")]) }
    );

    expect(response.status).toBe(200);
    /*
     * A playback session is per-viewer and time-bounded. A shared cache holding
     * one would eventually serve one viewer's session to another.
     */
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await decision(response);
    expect(body.outcome).toBe("granted");
    if (body.outcome !== "granted") return;
    expect(body.session.candidates.map((entry) => entry.id)).toEqual(["aurora-fall-dash"]);
    expect(body.session.expiresAt).toBe("2026-08-20T09:05:00.000Z");
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("sends no-store on a refusal as well as on a grant", async () => {
    const response = await handlePlaybackSessionRequest(post("{not json"), FIXED);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the route module Next actually deploys", () => {
  it("answers a real request through POST", async () => {
    /*
     * THE ONLY TEST THAT EXECUTES `route.ts`. Everything above calls the handler
     * directly, which is the only way to inject a resolver -- and which means a
     * renamed export, a `POST` wired to something other than
     * `handlePlaybackSessionRequest`, or a dropped `await` would leave this
     * whole suite green while the deployed path was broken. (A stray second
     * export is the one failure mode NOT covered here: Next rejects that at
     * build time, so it surfaces as a failed build rather than a passing test.)
     *
     * It is also the only place the DEFAULT resolver runs, since a route module
     * has no parameter through which one could be supplied. That resolver is
     * gated on an ALLOWLIST of `NODE_ENV` values -- fixtures under `development`
     * and `test`, `not-configured` under every other value including none at all
     * -- so the assertion is written against BOTH of its states rather than
     * against whichever one this machine happens to be in.
     */
    const response = await POST(
      postJson({ contentId: "aurora-fall", capabilities: CAPABILITIES })
    );

    /* Not `toBeTruthy`: a dropped `await` in the route would hand back a
     * Promise, which has a `status` of `undefined` and would otherwise fail
     * three assertions later as a confusing mismatch. */
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await decision(response);

    if (body.outcome === "granted") {
      expect(response.status).toBe(200);
      /*
       * Ids rather than URIs, and sorted rather than in ranking order: the
       * fixture origin is an environment read, and the ranking's weights belong
       * to `@liberty/media-engine`'s own suite. What is pinned here is that the
       * deployed path resolved the fixtures and published all three.
       */
      expect([...body.session.candidates.map((entry) => entry.id)].sort()).toEqual([
        "aurora-fall-dash",
        "aurora-fall-hls",
        "aurora-fall-progressive"
      ]);
      return;
    }

    /* The production gate. Distinguishable from a provider outage, because the
     * operator's remedy is "configure a provider" rather than "wait". */
    expect(body.outcome).toBe("unavailable");
    expect(response.status).toBe(503);
    expect(body.reasons[0].code).toBe("provider_not_configured");
  });
});
