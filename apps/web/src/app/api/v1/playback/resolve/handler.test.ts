import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import { describe, expect, it } from "vitest";
import {
  MAX_CANDIDATES,
  MAX_REQUEST_BYTES,
  handlePlaybackResolveRequest,
  type ResolveScaffoldOptions
} from "./handler";

/*
 * The three defects PL-0702 found in this route, each pinned by a test that
 * fails against the code as it was:
 *
 *   - no environment guard, so a scaffold that accepts client-supplied rights
 *     was reachable from a hosted deployment;
 *   - no upper bound on `candidates`, so an unbounded array reached Zod's
 *     per-element validation and then `rankStreamCandidates`;
 *   - `await request.json()` outside any try, so a non-JSON body was a 500 with
 *     no reason trail.
 *
 * `available` is injected rather than set through `NODE_ENV`, because a test
 * that writes the process environment changes how every other test in the same
 * worker behaves -- and this suite runs in the `node` environment where that
 * worker is shared.
 */

/** The scaffold answering, which is what it does outside a hosted deployment. */
const ENABLED: ResolveScaffoldOptions = { available: true };
/** A hosted deployment, where this route is not part of the product. */
const HOSTED: ResolveScaffoldOptions = { available: false };

const CAPABILITIES = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
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

/** Distinct ids, so a list of n candidates is n candidates after deduplication. */
function candidates(count: number): StreamCandidate[] {
  return Array.from({ length: count }, (_, index) => ({ ...CANDIDATE, id: `candidate-${index}` }));
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://liberty.test/api/v1/playback/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("the resolve scaffold is not part of a hosted deployment", () => {
  it("answers 404 without reading the body", async () => {
    /*
     * The route's own contract has always called it a testability scaffold, and
     * that sentence lived only in docs/API_CONTRACTS.md. A document is not a
     * control: the code ran identically wherever it was deployed, so a hosted
     * instance published a rights verdict to any anonymous caller who asked.
     */
    const response = await handlePlaybackResolveRequest(
      post({ contentId: "aurora-fall", capabilities: CAPABILITIES, candidates: candidates(1) }),
      HOSTED
    );

    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(isRecord(body) && body["error"]).toBe("route_not_available");
    /* Names the route that does the same job the right way round, so the
     * refusal is actionable rather than merely closed. */
    expect(isRecord(body) && String(body["detail"])).toContain("/api/v1/playback/session");
  });

  it("refuses even a request that would otherwise have been valid", async () => {
    // The control for the test above: without it, a 404 would be equally
    // consistent with the route having simply stopped working.
    const valid = {
      contentId: "aurora-fall",
      capabilities: CAPABILITIES,
      candidates: candidates(1)
    };

    expect((await handlePlaybackResolveRequest(post(valid), ENABLED)).status).toBe(200);
    expect((await handlePlaybackResolveRequest(post(valid), HOSTED)).status).toBe(404);
  });
});

describe("the resolve scaffold bounds the work a caller can buy", () => {
  it("refuses an oversized candidate list before validating or ranking it", async () => {
    /*
     * `playbackResolveRequestSchema` bounds `candidates` below (`.min(1)`) and
     * not above, so this array previously reached Zod's per-element validation
     * and then `rankStreamCandidates`, which scores every candidate against
     * every capability and sorts the result. A short body of repeated objects
     * bought a large amount of server work.
     */
    const response = await handlePlaybackResolveRequest(
      post({
        contentId: "aurora-fall",
        capabilities: CAPABILITIES,
        candidates: candidates(MAX_CANDIDATES + 1)
      }),
      ENABLED
    );

    expect(response.status).toBe(413);
    const body: unknown = await response.json();
    expect(isRecord(body) && body["error"]).toBe("too_many_candidates");
    /* Not a ranking. A 413 that still carried `selected` would be a refusal a
     * caller could ignore. */
    expect(isRecord(body) && "selected" in body).toBe(false);
  });

  it("still ranks a list exactly at the cap, so the refusal is about size", async () => {
    const response = await handlePlaybackResolveRequest(
      post({
        contentId: "aurora-fall",
        capabilities: CAPABILITIES,
        candidates: candidates(MAX_CANDIDATES)
      }),
      ENABLED
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isRecord(body) && body["selected"]).toBeTruthy();
  });

  it("refuses a body whose declared length exceeds the cap", async () => {
    /*
     * `content-length` is a claim rather than a measurement, so this is the
     * cheap early exit and not the whole control -- see the note on
     * `MAX_REQUEST_BYTES` for why the metered read that would be the real one
     * is deliberately absent from a route that cannot be reached in production.
     */
    const request = post(
      { contentId: "aurora-fall", capabilities: CAPABILITIES, candidates: candidates(1) },
      { "content-length": String(MAX_REQUEST_BYTES + 1) }
    );

    /* Asserted before the handler runs, so that a runtime which declined to
     * carry the header fails here -- naming the environment -- rather than
     * three lines down, where it would read as the guard not working. */
    expect(request.headers.get("content-length")).toBe(String(MAX_REQUEST_BYTES + 1));

    const response = await handlePlaybackResolveRequest(request, ENABLED);

    expect(response.status).toBe(413);
    const body: unknown = await response.json();
    expect(isRecord(body) && body["error"]).toBe("request_too_large");
  });
});

describe("the resolve scaffold answers a malformed body without faulting", () => {
  it("treats a non-JSON body as a client error rather than a 500", async () => {
    /*
     * `await request.json()` sat outside any try, so this threw out of the
     * route and Next turned it into a 500 with no reason trail -- the exact
     * failure `../session/handler.ts` was written to avoid, in the route beside
     * it. docs/E2E.md already names this route as the one that does it.
     */
    const response = await handlePlaybackResolveRequest(post("not json at all"), ENABLED);

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(isRecord(body) && body["error"]).toBe("invalid_request");
  });

  it("treats an empty body the same way", async () => {
    const response = await handlePlaybackResolveRequest(post(""), ENABLED);
    expect(response.status).toBe(400);
  });

  it("never lets a verdict be cached, on any branch", async () => {
    /*
     * A ranking verdict is per-device and per-request. The branches differ in
     * status and in body, and a shared cache holding any of them would serve
     * one device's answer to another.
     */
    const bodies: ReadonlyArray<readonly [unknown, ResolveScaffoldOptions]> = [
      [{ contentId: "aurora-fall", capabilities: CAPABILITIES, candidates: candidates(1) }, ENABLED],
      [{ contentId: "aurora-fall", capabilities: CAPABILITIES, candidates: candidates(1) }, HOSTED],
      ["not json at all", ENABLED],
      [
        {
          contentId: "aurora-fall",
          capabilities: CAPABILITIES,
          candidates: candidates(MAX_CANDIDATES + 1)
        },
        ENABLED
      ]
    ];

    for (const [body, options] of bodies) {
      const response = await handlePlaybackResolveRequest(post(body), options);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
