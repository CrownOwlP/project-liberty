import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  playbackSessionResponseSchema,
  type PlaybackSessionResponse
} from "./contract";
import { boundRequestBody, MAX_REQUEST_BODY_BYTES, playbackSessionResponse } from "./handler";
import {
  decidePlaybackSession,
  IDENTITY_HEADERS,
  PLAYBACK_SESSION_PATH
} from "./playback-session-implementation.desktop";

/* -------------------------------------------------------------------------
 * THE FORWARDING IMPLEMENTATION (docs/DESKTOP_PLAYBACK.md §8)
 *
 * This module never runs in the web build, so nothing else in this repository
 * exercises it: `route.ts`, `handler.ts` and the other four suites all resolve
 * the on-device implementation. That is the "second code path needing its own
 * tests" §8 accepts as one of the ruling's two costs, and this file is it.
 *
 * WHAT IS PINNED, in the order the ruling states it:
 *
 *   1. the contract in front of the boundary is the same one -- same path, same
 *      request bytes, same response shape, same status codes, same `no-store`;
 *   2. an authenticated caller identity is forwarded, and NOTHING ELSE is;
 *   3. no provider credential is carried, and a forwarder that grew one would
 *      have to defeat an allowlist to send it;
 *   4. a backend that is absent, refused, unreachable or off-contract produces
 *      an HONEST `unavailable`, never a local resolution and never a throw.
 * ---------------------------------------------------------------------- */

const BACKEND = "https://playback.liberty.test";

const CAPABILITIES = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

const REQUEST_BODY = JSON.stringify({ contentId: "aurora-fall", capabilities: CAPABILITIES });

/** A grant exactly as the resolving implementation would publish one, including
 * PL-0902's `protection` descriptor -- so this also pins that the forwarder
 * relays the field rather than dropping it on the way through. */
const GRANTED: PlaybackSessionResponse = {
  outcome: "granted",
  reasons: [
    {
      code: "session_issued",
      candidateId: null,
      detail: "1 candidate(s) authorized and ranked for aurora-fall"
    }
  ],
  session: {
    sessionId: "f0f1e0a4-6d1c-4f0b-9a3e-2a1d4c5b6e7f",
    contentId: "aurora-fall",
    candidates: [
      {
        id: "aurora-fall-dash",
        providerId: "fixture",
        uri: "https://cdn.example.com/aurora-fall/manifest.mpd",
        mimeType: "application/dash+xml",
        compatibility: "verified",
        protection: { state: "protected", keySystem: "widevine", licenseUrl: null }
      }
    ],
    startAtSeconds: null,
    expiresAt: "2026-08-20T09:05:00.000Z",
    failoverPolicy: { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 }
  }
};

const DENIED: PlaybackSessionResponse = {
  outcome: "denied",
  reasons: [
    {
      code: "rights_not_established",
      candidateId: null,
      detail: "no candidate carries a rights basis this platform may play from"
    }
  ]
};

const MALFORMED: PlaybackSessionResponse = {
  outcome: "denied",
  reasons: [{ code: "request_malformed", candidateId: null, detail: "request: expected object" }]
};

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly cache: string | undefined;
  readonly redirect: string | undefined;
}

/** A backend, captured. Answers whatever it is told to and records the call. */
function backend(answer: () => Promise<Response> | Response): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : String(init?.body),
      cache: init?.cache,
      redirect: init?.redirect
    });
    return answer();
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

function answering(payload: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(payload), { status });
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://liberty.desktop.test/api/v1/playback/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });
}

async function decision(response: Response): Promise<PlaybackSessionResponse> {
  return playbackSessionResponseSchema.parse(await response.json());
}

describe("the contract in front of the boundary is the same contract", () => {
  it("posts the request bytes, unchanged, to the same path on the backend", async () => {
    const remote = backend(answering(GRANTED));
    await decidePlaybackSession(post(REQUEST_BODY), {
      fetch: remote.fetch,
      backendOrigin: BACKEND
    });

    expect(remote.calls).toHaveLength(1);
    const call = remote.calls[0];
    expect(call?.url).toBe(`${BACKEND}${PLAYBACK_SESSION_PATH}`);
    expect(call?.method).toBe("POST");
    /*
     * BYTE-FOR-BYTE. Not re-serialised from a parsed object: what the request
     * said is the resolving implementation's decision to take, and a forwarder
     * that normalised the body would answer a malformed request in two places.
     */
    expect(call?.body).toBe(REQUEST_BODY);
  });

  it("forwards a body that is not JSON without deciding anything about it", async () => {
    /* The web build answers this `denied`/`request_malformed` after trying to
     * parse it. The desktop build must ship the same bytes and let the same
     * code, running on the backend, reach the same answer -- otherwise the
     * malformed-body rule exists twice and can drift. */
    const remote = backend(answering(MALFORMED));
    const answer = await decidePlaybackSession(post("{not json"), {
      fetch: remote.fetch,
      backendOrigin: BACKEND
    });

    expect(remote.calls[0]?.body).toBe("{not json");
    expect(answer).toEqual(MALFORMED);
    expect(playbackSessionResponse(answer).status).toBe(400);
  });

  it("relays each outcome with the status and headers the web build gives it", async () => {
    /*
     * The status is not read from the backend: `handler.ts` derives it from the
     * decision with `playbackSessionHttpStatus`, which is the same function the
     * web build uses, so the wire status and the outcome cannot disagree and
     * cannot differ between targets. The backend below answers 200 for all
     * three deliberately -- if the forwarder were echoing upstream statuses
     * this test would catch it.
     */
    const cases: readonly (readonly [PlaybackSessionResponse, number])[] = [
      [GRANTED, 200],
      [DENIED, 403],
      [MALFORMED, 400]
    ];

    for (const [payload, status] of cases) {
      const remote = backend(answering(payload, 200));
      const response = playbackSessionResponse(
        await decidePlaybackSession(post(REQUEST_BODY), {
          fetch: remote.fetch,
          backendOrigin: BACKEND
        })
      );

      expect(response.status, payload.outcome).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await decision(response)).toEqual(payload);
    }
  });

  it("relays the protection descriptor verbatim", async () => {
    /* PL-0902's field is player-input and the router decides on it. A forwarder
     * that dropped or defaulted it would publish a session the desktop's own
     * mpv adapter would then route on wrong information. */
    const remote = backend(answering(GRANTED));
    const answer = await decidePlaybackSession(post(REQUEST_BODY), {
      fetch: remote.fetch,
      backendOrigin: BACKEND
    });

    expect(answer.outcome).toBe("granted");
    if (answer.outcome !== "granted") return;
    expect(answer.session.candidates[0].protection).toEqual({
      state: "protected",
      keySystem: "widevine",
      licenseUrl: null
    });
  });

  it("mirrors the route it stands in for, so the forwarded path cannot drift", () => {
    /*
     * Derived from this module's own position under `app/` rather than written
     * out twice. `app/api/v1/playback/session/route.ts` is served at
     * `/api/v1/playback/session`, so moving the directory without updating the
     * constant fails here rather than silently forwarding to a path the backend
     * does not serve.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const underApp = relative(here.slice(0, here.lastIndexOf("/app/") + "/app".length), here);
    expect(`/${underApp.split("\\").join("/")}`).toBe(PLAYBACK_SESSION_PATH);
  });
});

describe("what the forwarder carries, and what it must never carry", () => {
  it("forwards the caller's identity headers", async () => {
    const remote = backend(answering(GRANTED));
    await decidePlaybackSession(
      post(REQUEST_BODY, {
        cookie: "liberty_session=abc; active_profile_selection=kid",
        authorization: "Bearer caller-identity",
        "x-liberty-development-account": "household-2",
        "x-liberty-development-session": "session-2"
      }),
      { fetch: remote.fetch, backendOrigin: BACKEND }
    );

    const headers = remote.calls[0]?.headers ?? {};
    expect(headers["cookie"]).toBe("liberty_session=abc; active_profile_selection=kid");
    expect(headers["authorization"]).toBe("Bearer caller-identity");
    expect(headers["x-liberty-development-account"]).toBe("household-2");
    expect(headers["x-liberty-development-session"]).toBe("session-2");
  });

  it("forwards nothing outside the allowlist, including anything credential-shaped", async () => {
    /*
     * §8: the proxy "never receives a provider credential", and the desktop
     * build never ships one. This asserts the mechanism that makes that true of
     * the REQUEST as well: the outbound header set is an allowlist, so a
     * provider key that somehow reached this process -- in an inbound header,
     * from a misconfigured shell, from a future edit -- is not forwarded
     * because nothing copies it. A denylist would have had to know its name.
     */
    const remote = backend(answering(GRANTED));
    await decidePlaybackSession(
      post(REQUEST_BODY, {
        "x-provider-api-key": "provider-secret",
        "x-liberty-sidecar-token": "loopback-bearer",
        "proxy-authorization": "Basic c2VjcmV0",
        "x-forwarded-for": "10.0.0.9",
        "user-agent": "liberty-desktop/1.0"
      }),
      { fetch: remote.fetch, backendOrigin: BACKEND }
    );

    const sent = Object.keys(remote.calls[0]?.headers ?? {}).sort();
    /* `content-type` is composed here, not copied. Everything else must be an
     * allowlist member. */
    expect(sent).toEqual(["content-type"]);
    for (const value of Object.values(remote.calls[0]?.headers ?? {})) {
      expect(value).not.toContain("provider-secret");
      expect(value).not.toContain("loopback-bearer");
    }
  });

  it("keeps the allowlist to identity and nothing else", () => {
    expect([...IDENTITY_HEADERS].sort()).toEqual([
      "authorization",
      "cookie",
      "x-liberty-development-account",
      "x-liberty-development-session"
    ]);
  });

  it("does not cache and does not follow a redirect", async () => {
    /*
     * `no-store` for the reason the response carries it. `redirect: "error"`
     * because following one would re-send the caller's identity to whatever
     * origin the redirect named -- a credential-forwarding decision a forwarder
     * with no policy in it has no business taking.
     */
    const remote = backend(answering(GRANTED));
    await decidePlaybackSession(post(REQUEST_BODY), {
      fetch: remote.fetch,
      backendOrigin: BACKEND
    });

    expect(remote.calls[0]?.cache).toBe("no-store");
    expect(remote.calls[0]?.redirect).toBe("error");
  });

  it("contains no provider credential and no resolution vocabulary", async () => {
    /*
     * Read as text rather than argued from the imports. A forwarder is supposed
     * to be boring; the moment this file mentions a key, a secret or a provider
     * adapter, it has stopped being one.
     */
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      fileURLToPath(new URL("./playback-session-implementation.desktop.ts", import.meta.url)),
      "utf8"
    );
    for (const forbidden of [
      "@liberty/provider-sdk",
      "@liberty/media-engine",
      "createFixtureProvider",
      "rankStreamCandidates",
      "checkUrl"
    ]) {
      /* `checkUrl` appears in this module's prose, explaining why it is NOT
       * imported, so the check is for a call rather than for the word. */
      expect(source).not.toContain(`${forbidden}(`);
      expect(source).not.toContain(`from "${forbidden}"`);
    }
  });
});

describe("a backend that cannot answer produces an honest unavailable", () => {
  async function refusal(
    options: Parameters<typeof decidePlaybackSession>[1]
  ): Promise<PlaybackSessionResponse> {
    return decidePlaybackSession(post(REQUEST_BODY), options);
  }

  it("says provider_not_configured when no backend is configured", async () => {
    const remote = backend(answering(GRANTED));
    const answer = await refusal({ fetch: remote.fetch, backendOrigin: "" });

    expect(answer.outcome).toBe("unavailable");
    expect(answer.reasons[0].code).toBe("provider_not_configured");
    /* Nothing was attempted, and in particular nothing was resolved locally. */
    expect(remote.calls).toHaveLength(0);
    expect(playbackSessionResponse(answer).status).toBe(503);
  });

  it("refuses a backend origin that is not an https URL without credentials", async () => {
    const remote = backend(answering(GRANTED));
    for (const origin of [
      "http://playback.liberty.test",
      "https://user:pass@playback.liberty.test",
      "not-a-url",
      "//playback.liberty.test",
      "ftp://playback.liberty.test",
      "https://"
    ]) {
      const answer = await refusal({ fetch: remote.fetch, backendOrigin: origin });
      expect(answer.outcome, origin).toBe("unavailable");
      expect(answer.reasons[0].code, origin).toBe("provider_unavailable");
    }
    expect(remote.calls).toHaveLength(0);
  });

  it("judges a near-miss spelling by what it resolves to, not by how it looks", async () => {
    /*
     * `https:/\/evil.test` is the shape a prefix test gets wrong: a check for
     * the literal `https://` rejects it while a check for `https:` accepts it
     * without noticing that the authority moved. `URL` resolves it to
     * `https://evil.test/`, so it is admitted -- correctly, as an https origin
     * with no credentials, which is all this function claims to decide. WHICH
     * https backend is legitimate is an operator's question and not a
     * refusal this forwarder can invent; what matters is that the address the
     * request goes to is the one the parse produced and not the raw string.
     */
    const remote = backend(answering(GRANTED));
    const answer = await refusal({ fetch: remote.fetch, backendOrigin: "https:/\\/evil.test" });

    expect(answer.outcome).toBe("granted");
    expect(remote.calls[0]?.url).toBe(`https://evil.test${PLAYBACK_SESSION_PATH}`);
  });

  it("says provider_unavailable when the backend cannot be reached", async () => {
    const remote = backend(() => {
      throw new TypeError("fetch failed: ECONNREFUSED 10.1.2.3:443");
    });
    const answer = await refusal({ fetch: remote.fetch, backendOrigin: BACKEND });

    expect(answer.outcome).toBe("unavailable");
    expect(answer.reasons[0].code).toBe("provider_unavailable");
    /* The thrown text is NOT echoed: a network exception's message is whatever
     * a library felt like saying, up to an internal address or a token. */
    expect(answer.reasons[0].detail).not.toContain("10.1.2.3");
    expect(answer.reasons[0].detail).not.toContain("ECONNREFUSED");
  });

  it("says provider_unavailable for an answer that is not JSON", async () => {
    const remote = backend(() => new Response("<html>502</html>", { status: 502 }));
    const answer = await refusal({ fetch: remote.fetch, backendOrigin: BACKEND });

    expect(answer.outcome).toBe("unavailable");
    expect(answer.reasons[0].code).toBe("provider_unavailable");
  });

  it("refuses to relay a body that is outside the published contract", async () => {
    /*
     * The one place a forwarder could quietly break the contract is by echoing
     * bytes it did not understand. Both of these are plausible things a real
     * backend emits -- a framework error envelope and a decision that lost its
     * reason trail -- and neither may reach a client as a playback decision.
     */
    for (const payload of [
      { error: "internal_error" },
      { outcome: "granted", reasons: [], session: null },
      { outcome: "elsewhere", reasons: [{ code: "session_issued", candidateId: null, detail: "x" }] }
    ]) {
      const remote = backend(answering(payload));
      const answer = await refusal({ fetch: remote.fetch, backendOrigin: BACKEND });
      expect(answer.outcome, JSON.stringify(payload)).toBe("unavailable");
      expect(answer.reasons[0].code).toBe("provider_unavailable");
    }
  });

  it("never throws, whatever the backend does", async () => {
    const throwers: (() => Response)[] = [
      () => {
        throw new Error("boom");
      },
      () => new Response("", { status: 204 }),
      () => new Response("null", { status: 200 })
    ];

    for (const answer of throwers) {
      const remote = backend(answer);
      const result = await refusal({ fetch: remote.fetch, backendOrigin: BACKEND });
      expect(result.outcome).toBe("unavailable");
      expect(result.reasons.length).toBeGreaterThan(0);
      /* Every branch is a member of the published union, validated. */
      expect(() => playbackSessionResponseSchema.parse(result)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------
 * The request body bound, under THIS target (PL-0707, register entry F10)
 * ---------------------------------------------------------------------- */

describe("the oversized-body refusal reaches the forwarding target too", () => {
  /**
   * The composition the desktop build runs, written out by hand.
   *
   * A vitest run resolves `playback-session-implementation.ts`, so
   * `handlePlaybackSessionRequest` cannot be called here and be the desktop
   * one. What CAN be called is each piece of the shared envelope -- the gate,
   * this target's `decidePlaybackSession`, and `playbackSessionResponse` -- in
   * the order `handler.ts` calls them, which is what the desktop build compiles.
   * The suite above already uses the same technique for the status derivation.
   */
  async function throughDesktopEnvelope(
    request: Request,
    options: { readonly fetch: typeof globalThis.fetch }
  ): Promise<Response> {
    const bounded = await boundRequestBody(request);
    if (!bounded.ok) return bounded.response;
    return playbackSessionResponse(
      await decidePlaybackSession(bounded.request, { ...options, backendOrigin: BACKEND })
    );
  }

  /** The bound, as a literal, for the reason the web suite gives at length: a
   * fixture sized from the constant under test cannot produce an honest red. */
  const DECLARED_BOUND = 16 * 1024;

  /** Schema-valid in every respect except size. See the web suite for why the
   * padding goes into `preferredAudioLanguages` rather than an unknown key. */
  function bodyOfAtLeast(bytes: number): string {
    const languages: string[] = [];
    const encoder = new TextEncoder();
    let json = "";
    do {
      languages.push(`en-gb-${String(languages.length).padStart(14, "0")}`);
      json = JSON.stringify({
        contentId: "aurora-fall",
        capabilities: { ...CAPABILITIES, preferredAudioLanguages: languages }
      });
    } while (encoder.encode(json).length < bytes);
    return json;
  }

  it("uses the same named bound the shared envelope exports", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(DECLARED_BOUND);
  });

  it("refuses an oversized body WITHOUT forwarding it to the backend", async () => {
    /*
     * The finding this closes is that `request.text()` on line 254 of the
     * forwarder was as unbounded as `request.json()` was on the web side. The
     * assertion that matters is not only the 413: it is `calls` being EMPTY.
     * A cap that refused after forwarding would have relayed the whole body to
     * the backend first, turning this process into an amplifier pointed at our
     * own infrastructure instead of merely at its own heap.
     */
    const remote = backend(answering(GRANTED));
    const response = await throughDesktopEnvelope(
      post(bodyOfAtLeast(DECLARED_BOUND + 1)),
      { fetch: remote.fetch }
    );

    expect(response.status).toBe(413);
    expect(remote.calls).toHaveLength(0);

    const body = await decision(response);
    expect(body.outcome).toBe("denied");
    expect(body.reasons[0].code).toBe("request_body_too_large");
  });

  it("forwards a body just under the bound, byte for byte", async () => {
    /*
     * Two things at once. The outage guard -- a body near the limit is handled
     * normally -- and the regression that the gate's REPLAY is faithful: the
     * envelope now hands the implementation a reconstructed Request rather than
     * the original one, and the forwarder's byte-for-byte promise would be
     * quietly broken by a gate that re-serialised or truncated anything.
     */
    const justUnder = bodyOfAtLeast(DECLARED_BOUND - 500);
    const remote = backend(answering(GRANTED));
    const response = await throughDesktopEnvelope(post(justUnder), { fetch: remote.fetch });

    expect(response.status).toBe(200);
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]?.body).toBe(justUnder);
  });

  it("still forwards the identity headers the gate copied across", async () => {
    /* The replayed Request carries the original headers, so the allowlist the
     * forwarder applies sees exactly what the caller sent. */
    const remote = backend(answering(GRANTED));
    await throughDesktopEnvelope(
      post(REQUEST_BODY, { cookie: "liberty_session=abc", "x-liberty-development-account": "dev" }),
      { fetch: remote.fetch }
    );

    expect(remote.calls[0]?.headers["cookie"]).toBe("liberty_session=abc");
    expect(remote.calls[0]?.headers["x-liberty-development-account"]).toBe("dev");
  });
});
