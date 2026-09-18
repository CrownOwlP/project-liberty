import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import { PROTECTION_NOT_STATED } from "@liberty/contracts/shared/drm";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { describe, expect, it } from "vitest";
import type { AuthorizedCandidate, AuthorizedCandidateResolver } from "./authorized-candidates";
import { playbackSessionResponseSchema, type PlaybackSessionResponse } from "./contract";
import { handlePlaybackSessionRequest, MAX_REQUEST_BODY_BYTES } from "./handler";
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
    },
    /* What a resolver with nothing to say must state out loud. `unknown`
     * requires a CDM, so the conservative value is also the cheap one. */
    protection: PROTECTION_NOT_STATED
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

/* -------------------------------------------------------------------------
 * The request body bound (PL-0707, register entry F10 in
 * docs/SECURITY_REVIEW_PROVIDER_URL.md)
 * ---------------------------------------------------------------------- */

/**
 * The bound these tests were written against, restated as a literal.
 *
 * NOT `MAX_REQUEST_BODY_BYTES`, deliberately. A test that sizes its own fixture
 * from the constant under test can only ever assert that the code agrees with
 * itself: run against a tree where the constant does not exist, the padding
 * loop degenerates and the "oversized" body is not oversized at all, so the
 * refusal it fails to observe was never actually provoked. Sizing from a literal
 * keeps the red observation honest -- the body really is over 16 KiB whatever
 * the source tree says -- and the one assertion below ties the literal back to
 * the exported constant, so the two cannot drift apart silently.
 */
const DECLARED_BOUND = 16 * 1024;

/**
 * A body whose only defect is its size.
 *
 * DELIBERATELY SCHEMA-VALID. Padding with an unrecognised key would have been
 * easier, but then a refusal would prove nothing: `.strict()` already refuses
 * that body, for an unrelated reason, at a different status. Growing
 * `preferredAudioLanguages` -- `z.array(z.string())`, bounded neither in length
 * nor in element size -- produces a request that every schema in the contract
 * accepts and that only the cap can turn away. Before this task, the largest of
 * these was answered `200 granted`.
 */
function bodyOfAtLeast(bytes: number): string {
  const languages: string[] = [];
  const encoder = new TextEncoder();
  let json = "";

  do {
    /* 20 characters, so each entry adds a predictable 23 bytes of JSON and the
     * loop terminates in a bounded number of steps rather than one per byte. */
    languages.push(`en-gb-${String(languages.length).padStart(14, "0")}`);
    json = JSON.stringify({
      contentId: "aurora-fall",
      capabilities: { ...CAPABILITIES, preferredAudioLanguages: languages }
    });
  } while (encoder.encode(json).length < bytes);

  return json;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A body sent as a stream, which is what `Transfer-Encoding: chunked` looks
 * like on this side: there is no `content-length` header to consult at all. */
function postStreamed(body: string): Request {
  const encoded = new TextEncoder().encode(body);
  return new Request("https://liberty.test/api/v1/playback/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        /* In pieces, so the metered read has to stop part-way through rather
         * than be handed the whole thing in one chunk. */
        for (let at = 0; at < encoded.length; at += 4096) {
          controller.enqueue(encoded.slice(at, at + 4096));
        }
        controller.close();
      }
    }),
    /* Required by undici for a streaming request body. */
    duplex: "half"
  } as RequestInit & { duplex: "half" });
}

describe("the request body is bounded before it is buffered", () => {
  it("states the bound as a named constant, at the value these tests assume", () => {
    /*
     * The acceptance asks for a named constant with its reason written down,
     * not a magic number. The reason lives in the doc comment on the constant
     * itself; what a test can check is that the name exists, is exported, and
     * carries the value every fixture below is sized against.
     */
    expect(MAX_REQUEST_BODY_BYTES).toBe(DECLARED_BOUND);
  });

  it("refuses a body over the bound with 413 and a size reason, not a shape one", async () => {
    const oversized = bodyOfAtLeast(DECLARED_BOUND + 1);
    expect(byteLength(oversized)).toBeGreaterThan(DECLARED_BOUND);

    const response = await handlePlaybackSessionRequest(post(oversized), {
      ...FIXED,
      resolve: resolving([authorizedWith("owned")])
    });

    /*
     * 413 and not 400. `request_malformed` was available and was rejected in
     * review: it would report a size refusal as a shape refusal, in the one
     * trail that exists to explain decisions accurately. A body this route
     * would have granted if it were smaller is not malformed.
     */
    expect(response.status).toBe(413);
    const body = await decision(response);
    expect(body.outcome).toBe("denied");
    expect(body.reasons[0].code).toBe("request_body_too_large");
    expect(body.reasons[0].detail).toContain(String(MAX_REQUEST_BODY_BYTES));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("handles a body just under the bound normally", async () => {
    /*
     * A cap that refuses everything is indistinguishable from an outage, and a
     * cap tested only from above would be satisfied by one. This body is within
     * a few hundred bytes of the limit and must be GRANTED -- so a later edit
     * that tightens the bound by an order of magnitude fails here rather than in
     * production.
     */
    const justUnder = bodyOfAtLeast(DECLARED_BOUND - 500);
    expect(byteLength(justUnder)).toBeLessThan(DECLARED_BOUND);
    expect(byteLength(justUnder)).toBeGreaterThan(DECLARED_BOUND - 600);

    const response = await handlePlaybackSessionRequest(post(justUnder), {
      ...FIXED,
      resolve: resolving([authorizedWith("owned")])
    });

    expect(response.status).toBe(200);
    const body = await decision(response);
    expect(body.outcome).toBe("granted");
    if (body.outcome !== "granted") return;
    expect(body.session.candidates.map((entry) => entry.id)).toEqual(["aurora-fall-dash"]);
  });

  it("refuses an oversized body that DECLARES a small content-length", async () => {
    /*
     * THE HEADER IS NOT THE BOUND. A declared length is a claim, and a caller
     * that wanted to defeat a header check would simply lie -- so a route whose
     * only control was `content-length` would have a limit an attacker opts
     * into. The metered read is what actually bounds memory; the header only
     * ever lets an honest over-declaration be refused sooner.
     */
    const oversized = bodyOfAtLeast(DECLARED_BOUND + 1);
    const lying = new Request("https://liberty.test/api/v1/playback/session", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "42" },
      body: oversized
    });
    expect(lying.headers.get("content-length")).toBe("42");

    const response = await handlePlaybackSessionRequest(lying, {
      ...FIXED,
      resolve: resolving([authorizedWith("owned")])
    });

    expect(response.status).toBe(413);
    expect((await decision(response)).reasons[0].code).toBe("request_body_too_large");
  });

  it("refuses an oversized body sent with NO content-length at all", async () => {
    /* Chunked transfer encoding declares nothing. If the header were the bound,
     * this request would have no bound. */
    const streamed = postStreamed(bodyOfAtLeast(DECLARED_BOUND + 1));
    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await handlePlaybackSessionRequest(streamed, {
      ...FIXED,
      resolve: resolving([authorizedWith("owned")])
    });

    expect(response.status).toBe(413);
    expect((await decision(response)).reasons[0].code).toBe("request_body_too_large");
  });

  it("refuses without running the implementation at all", async () => {
    /*
     * THIS IS WHAT MAKES THE CAP TARGET-INDEPENDENT. `handler.ts` is the whole
     * of what sits in front of the build-target seam, and the gate runs before
     * `decidePlaybackSession` is called -- so the resolver below is never
     * reached, and neither is the desktop forwarder that replaces it in the
     * other build. A cap written inside either implementation could not make
     * this assertion.
     */
    const response = await handlePlaybackSessionRequest(
      post(bodyOfAtLeast(DECLARED_BOUND + 1)),
      {
        ...FIXED,
        resolve: () => {
          throw new Error("the implementation must not be reached for an oversized body");
        }
      }
    );

    expect(response.status).toBe(413);
  });

  it("answers a body it could not read as malformed rather than as too large", async () => {
    /*
     * The inverse of the mistake above, and just as misleading: a socket that
     * died mid-body is a shape event, not a size event. Pinned so that the two
     * failure modes of the same read never collapse into one code.
     */
    const broken = new Request("https://liberty.test/api/v1/playback/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"));
        }
      }),
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const response = await handlePlaybackSessionRequest(broken, FIXED);

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("request_malformed");
  });
});
