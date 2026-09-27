import { describe, expect, it, vi } from "vitest";
import type { AuthorizedCandidateResolver } from "./authorized-candidates";
import {
  NOT_AUTHENTICATED_DETAIL,
  playbackSessionResponseSchema,
  type PlaybackSessionResponse
} from "./contract";
import { handlePlaybackSessionRequest } from "./handler";
import {
  decidePlaybackSession,
  type PlaybackSessionOptions
} from "./playback-session-implementation";

/*
 * THE AUTHENTICATION GATE ON THE PLAYBACK SESSION ROUTE (PW-0312).
 *
 * What is pinned here is not "signed-out callers are refused" -- that is one
 * line of it. It is the four properties gpt-architect's round-90 ruling named,
 * each of which is a way the obvious implementation goes wrong:
 *
 *   1. AUTHENTICATION PRECEDES CONTENT LOOKUP, asserted as "the resolver is
 *      never reached" rather than by reading the source.
 *   2. NO CONTENT-EXISTENCE LEAK, asserted by comparing the refusal BYTES for a
 *      request naming a real title, an invented one, a malformed one, and a
 *      body that is not JSON at all.
 *   3. `not_authenticated` IS DISTINCT FROM UNAVAILABILITY, in both directions:
 *      a signed-out viewer is never told to wait, and an identity store outage
 *      never tells a signed-in viewer to sign in.
 *   4. THE REFUSAL IS CONDITIONAL ON AN IDENTITY SYSTEM EXISTING. A deployment
 *      with none behaves exactly as it did before this gate was written.
 *
 * Every dependency is injected. Nothing here needs PostgreSQL, an auth
 * instance, or an environment variable, which is the point of the option bag
 * `playback-session-implementation.ts` exposes.
 */

const CAPABILITIES = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

function sessionRequest(body: unknown): Request {
  return new Request("https://liberty.test/api/v1/playback/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

/**
 * `NonNullable` because the option is optional and `exactOptionalPropertyTypes`
 * is on: `PlaybackSessionOptions["authenticate"]` includes `undefined`, and a
 * helper typed as that could not be passed back into the field it came from.
 */
type Authenticator = NonNullable<PlaybackSessionOptions["authenticate"]>;

/** An authenticator that refuses, however the caller was refused. */
const refusing = (
  reason: "not_authenticated" | "authentication_not_configured" | "development_identifier_malformed",
  detail = "refused"
): Authenticator => async () => ({ ok: false, reason, detail });

const SIGNED_IN: Authenticator = async () => ({
  ok: true,
  account: { userId: "account-1", sessionId: "session-1" },
  detail: "verified database-backed session"
});

/** A resolver that fails the test if anything reaches it. */
function forbiddenResolver(): { resolve: AuthorizedCandidateResolver; calls: () => number } {
  let calls = 0;
  return {
    resolve: (contentId: string) => {
      calls += 1;
      return { status: "not-found", contentId };
    },
    calls: () => calls
  };
}

const NO_IDENTITY_SYSTEM = () => false;
const HAS_IDENTITY_SYSTEM = () => true;

describe("a signed-out caller", () => {
  it("is answered `unauthenticated` with the one reason code, in the published union", async () => {
    const response = await decidePlaybackSession(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      { authenticate: refusing("not_authenticated"), identityConfigured: HAS_IDENTITY_SYSTEM }
    );

    expect(playbackSessionResponseSchema.safeParse(response).success).toBe(true);
    expect(response.outcome).toBe("unauthenticated");
    expect(response.reasons[0].code).toBe("not_authenticated");
    expect(response.reasons[0].detail).toBe(NOT_AUTHENTICATED_DETAIL);
    expect(response.reasons[0].candidateId).toBeNull();
    /* A refusal that shipped a session would be the failure mode with teeth. */
    expect("session" in response).toBe(false);
  });

  it("reaches 401 through the envelope, with no-store, as a parseable body", async () => {
    const http = await handlePlaybackSessionRequest(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      { authenticate: refusing("not_authenticated"), identityConfigured: HAS_IDENTITY_SYSTEM }
    );

    expect(http.status).toBe(401);
    expect(http.headers.get("cache-control")).toBe("no-store");
    expect(playbackSessionResponseSchema.safeParse(await http.json()).success).toBe(true);
  });

  it("never reaches the resolver, so nothing is looked up for an unidentified caller", async () => {
    const resolver = forbiddenResolver();

    await decidePlaybackSession(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      {
        authenticate: refusing("not_authenticated"),
        identityConfigured: HAS_IDENTITY_SYSTEM,
        resolve: resolver.resolve
      }
    );

    expect(resolver.calls()).toBe(0);
  });

  it("leaves the request body UNREAD, which is why the refusal cannot leak a content id", async () => {
    /*
     * STRUCTURAL RATHER THAN CAREFUL. "The refusal does not mention the content
     * id" is a property of a string; "no content id was ever read" is a
     * property of the program, and it is the one that stays true when somebody
     * later adds a field to the refusal.
     */
    const request = sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES });

    await decidePlaybackSession(request, {
      authenticate: refusing("not_authenticated"),
      identityConfigured: HAS_IDENTITY_SYSTEM
    });

    expect(request.bodyUsed).toBe(false);
  });

  it("is refused BYTE-IDENTICALLY whatever the body said", async () => {
    const bodies: unknown[] = [
      /* A title the fixture catalog really carries. */
      { contentId: "aurora-fall", capabilities: CAPABILITIES },
      /* One nothing is registered under. */
      { contentId: "no-such-title-anywhere", capabilities: CAPABILITIES },
      /* A malformed id -- normally a 400 `request_malformed`. */
      { contentId: "NOT A CONTENT ID", capabilities: CAPABILITIES },
      /* A field this route refuses outright -- normally `request_field_not_permitted`. */
      { contentId: "aurora-fall", capabilities: CAPABILITIES, uri: "https://evil.test/x.mpd" },
      /* Not JSON at all. */
      "{ this is not json",
      /* Valid JSON, wrong type. */
      7
    ];

    const answers = new Set<string>();
    for (const body of bodies) {
      const http = await handlePlaybackSessionRequest(sessionRequest(body), {
        authenticate: refusing("not_authenticated"),
        identityConfigured: HAS_IDENTITY_SYSTEM
      });
      expect(http.status).toBe(401);
      answers.add(await http.text());
    }

    expect(answers.size).toBe(1);
  });
});

describe("a development identity header that is not well formed", () => {
  it("fails closed, says which kind of mistake it was, and does not echo the upstream detail", async () => {
    const response = await decidePlaybackSession(sessionRequest({ contentId: "aurora-fall" }), {
      authenticate: refusing(
        "development_identifier_malformed",
        'x-liberty-development-account is "  " and not an identifier'
      ),
      identityConfigured: HAS_IDENTITY_SYSTEM
    });

    expect(response.outcome).toBe("unauthenticated");
    expect(response.reasons[0].code).toBe("not_authenticated");
    /* The header NAME is a caller-supplied value on a route a forwarder talks
     * to; `session-endpoint.ts` declines the same echo for the same reason. */
    expect(response.reasons[0].detail).not.toContain("x-liberty-development-account");
    expect(response.reasons[0].detail).toContain("development identity header");
  });
});

describe("an identity store that exists and could not answer", () => {
  it("is an `unavailable`, NOT a request to sign in", async () => {
    /*
     * THE COLLAPSE THIS TASK FORBIDS, WITH THE OPERANDS SWAPPED. Telling a
     * signed-out viewer to wait for a provider was the defect; telling a
     * signed-in viewer to sign in during a database blip is the same mistake
     * pointing the other way, and it would make them re-enter a password that
     * was never the problem.
     */
    const response = await decidePlaybackSession(sessionRequest({ contentId: "aurora-fall" }), {
      authenticate: refusing("authentication_not_configured", "the session store could not be consulted"),
      identityConfigured: HAS_IDENTITY_SYSTEM
    });

    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].code).toBe("provider_unavailable");
  });

  it("answers 503 through the envelope", async () => {
    const http = await handlePlaybackSessionRequest(sessionRequest({ contentId: "aurora-fall" }), {
      authenticate: refusing("authentication_not_configured"),
      identityConfigured: HAS_IDENTITY_SYSTEM
    });
    expect(http.status).toBe(503);
  });

  it("does not echo what the store threw", async () => {
    const response = await decidePlaybackSession(sessionRequest({ contentId: "aurora-fall" }), {
      authenticate: async () => {
        throw new Error("postgres://liberty:hunter2@db.internal:5432/liberty refused");
      },
      identityConfigured: HAS_IDENTITY_SYSTEM
    });

    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].detail).not.toContain("hunter2");
    expect(response.reasons[0].detail).not.toContain("postgres");
  });
});

describe("a deployment with no identity system at all", () => {
  /*
   * THE REGRESSION gpt-architect ASKED FOR BY NAME IN ROUND 93, and the branch
   * it guards is the one the round-92 security review failed.
   *
   * WHAT USED TO HAPPEN HERE. This configuration fell through the gate and
   * decided playback, on my argument that a deployment with no identity system
   * has no sign-in for anyone to perform, so refusing there is a dead end. The
   * ruling: "Absence of the identity system must NOT become a bypass of
   * authentication in a deployment. A production deployment with no auth
   * store/configuration is misconfigured. It must fail closed." The dead end is
   * the correct answer, because the remedy is an operator's.
   *
   * These tests are written as the four claims that would each individually
   * have let the defect back in, rather than as one assertion about an outcome.
   */
  const noIdentitySystem = (resolve?: AuthorizedCandidateResolver): PlaybackSessionOptions => ({
    authenticate: refusing("authentication_not_configured", "no auth instance is configured"),
    identityConfigured: NO_IDENTITY_SYSTEM,
    ...(resolve === undefined ? {} : { resolve })
  });

  it("refuses a VALID request as unavailable, not as a playback decision", async () => {
    /*
     * A VALID request on purpose. A malformed one would be refused by the
     * schema whatever the gate did, so it could not tell a fail-closed gate
     * from an absent one.
     */
    const response = await decidePlaybackSession(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      noIdentitySystem()
    );

    expect(response.outcome).toBe("unavailable");
    /* `authentication_not_configured` and NOT `provider_not_configured`: the
     * provider registry is not the thing that is missing, and an operator sent
     * to look at it would find nothing wrong. It is the same code
     * `request-context.ts` publishes for this fact on every other route group. */
    expect(response.reasons[0].code).toBe("authentication_not_configured");
    /* NOT `unauthenticated`: there is no sign-in action available in this
     * state, so telling a viewer to sign in is an instruction they cannot
     * follow. The ruling is explicit -- "the correct external remedy is
     * operator configuration". */
    expect(response.reasons[0].detail).toContain("no identity system configured");
  });

  it("answers 503 through the envelope", async () => {
    const http = await handlePlaybackSessionRequest(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      noIdentitySystem()
    );
    expect(http.status).toBe(503);
    expect(http.headers.get("cache-control")).toBe("no-store");
  });

  it("does NOT reach content or provider resolution", async () => {
    /*
     * THE CLAUSE, ASSERTED AS A MECHANISM: "Do NOT continue into
     * content/provider resolution." A resolver that is never called cannot have
     * looked anything up, which is a stronger statement than any property of
     * the response body -- and it stays true when somebody later changes what
     * the refusal says.
     */
    const resolver = forbiddenResolver();
    await decidePlaybackSession(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES }),
      noIdentitySystem(resolver.resolve)
    );

    expect(resolver.calls()).toBe(0);
  });

  it("leaves the body UNREAD, so absence of auth is not a content oracle either", async () => {
    /*
     * gpt-architect: "assert the request body is still unread at the point this
     * refusal is produced if practical, so the absence-of-auth case cannot
     * become a content oracle either." It is practical, because the gate runs
     * in front of `readJsonBody` for every branch rather than for the
     * signed-out one only.
     */
    const request = sessionRequest({ contentId: "aurora-fall", capabilities: CAPABILITIES });
    await decidePlaybackSession(request, noIdentitySystem());
    expect(request.bodyUsed).toBe(false);
  });

  it("is refused BYTE-IDENTICALLY whatever the body said", async () => {
    /* The same non-oracle property the signed-out branch has, applied to this
     * one. A misconfigured deployment must not answer a real title differently
     * from an invented one either. */
    const answers = new Set<string>();
    for (const body of [
      { contentId: "aurora-fall", capabilities: CAPABILITIES },
      { contentId: "no-such-title-anywhere", capabilities: CAPABILITIES },
      { contentId: "NOT A CONTENT ID", capabilities: CAPABILITIES },
      "{ this is not json"
    ] as unknown[]) {
      const http = await handlePlaybackSessionRequest(sessionRequest(body), noIdentitySystem());
      expect(http.status).toBe(503);
      answers.add(await http.text());
    }

    expect(answers.size).toBe(1);
  });

  it("still tells an operator WHICH failure it was", async () => {
    /*
     * The two events under `authentication_not_configured` keep different
     * details, because "configure an identity store" and "your identity store
     * is down" send an operator to different places. Both are caller-invariant
     * and content-invariant -- statements about this deployment -- so neither
     * can become an oracle about a viewer or a title.
     */
    const absent = await decidePlaybackSession(sessionRequest({}), noIdentitySystem());
    const broken = await decidePlaybackSession(sessionRequest({}), {
      authenticate: refusing("authentication_not_configured", "the store threw"),
      identityConfigured: HAS_IDENTITY_SYSTEM
    });

    expect(absent.outcome).toBe(broken.outcome);
    expect(absent.reasons[0].detail).not.toBe(broken.reasons[0].detail);
  });
});

describe("an authenticated caller", () => {
  it("is decided on, and the identity is consulted exactly once", async () => {
    const authenticate = vi.fn(SIGNED_IN);
    const resolver = forbiddenResolver();

    const response: PlaybackSessionResponse = await decidePlaybackSession(
      sessionRequest({ contentId: "no-such-title-anywhere", capabilities: CAPABILITIES }),
      { authenticate, identityConfigured: HAS_IDENTITY_SYSTEM, resolve: resolver.resolve }
    );

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].code).toBe("content_not_found");
    expect(resolver.calls()).toBe(1);
  });
});
