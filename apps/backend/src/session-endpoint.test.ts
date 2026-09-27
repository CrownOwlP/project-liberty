import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  NOT_AUTHENTICATED_DETAIL,
  playbackSessionResponseSchema
} from "@liberty/web/playback-session/contract";
import {
  authenticateCaller,
  authenticationRefusalStatus,
  type AuthenticatedCaller
} from "./authentication";
import { handleSessionRequest } from "./session-endpoint";
import { routeRequest, SESSION_PATH, HEALTH_PATH } from "./router";

/**
 * The endpoint's two steps, and the order (PW-0401).
 *
 * No socket, no database, no auth library: authentication and the decision are
 * both injected, which is the whole reason they are parameters.
 */

const CAPABLE_DEVICE = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
} as const;

function sessionRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://backend.invalid${SESSION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const SIGNED_OUT = async () =>
  ({ ok: false, reason: "not_authenticated", detail: "no session" }) as const;
const NO_STORE = async () =>
  ({ ok: false, reason: "authentication_not_configured", detail: "none" }) as const;
const SIGNED_IN = async () =>
  ({
    ok: true,
    account: { userId: "viewer-1", sessionId: "session-1" },
    detail: "a verified session"
  }) as const;

describe("authentication happens before the body is read", () => {
  it("refuses a signed-out caller with 401 and never calls the decision", async () => {
    const decide = vi.fn();
    const response = await handleSessionRequest(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABLE_DEVICE }),
      { authenticate: SIGNED_OUT, decide }
    );
    expect(response.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it("leaves the body UNREAD, which is why the refusal cannot leak a content id", async () => {
    /*
     * The acceptance's "a refusal that does not leak whether a content id
     * exists", asserted as a mechanism rather than as an outcome. `bodyUsed`
     * is false because nothing between the socket and the refusal parsed
     * anything: there is no content id in scope for the answer to differ on.
     */
    const request = sessionRequest({ contentId: "aurora-fall", capabilities: CAPABLE_DEVICE });
    await handleSessionRequest(request, { authenticate: SIGNED_OUT });
    expect(request.bodyUsed).toBe(false);
  });

  it("answers byte-identically for a real id, an invented id, a malformed one and no JSON", async () => {
    const bodies: unknown[] = [
      { contentId: "aurora-fall", capabilities: CAPABLE_DEVICE },
      { contentId: "no-such-title-anywhere", capabilities: CAPABLE_DEVICE },
      { contentId: "NOT A VALID ID", capabilities: CAPABLE_DEVICE },
      { capabilities: CAPABLE_DEVICE },
      "not json at all",
      ""
    ];

    const answers = await Promise.all(
      bodies.map(async (body) => {
        const response = await handleSessionRequest(sessionRequest(body), {
          authenticate: SIGNED_OUT
        });
        return `${response.status} ${response.headers.get("cache-control")} ${await response.text()}`;
      })
    );

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain("not_authenticated");
    expect(answers[0]).toContain("unauthenticated");
    expect(answers[0]).toContain("no-store");
    /* And it does not echo any of the ids it was asked about. */
    expect(answers[0]).not.toContain("aurora-fall");
    expect(answers[0]).not.toContain("no-such-title");
  });

  it("refuses a signed-out caller INSIDE the published contract (PW-0312)", async () => {
    /*
     * THE CORRECTIVE gpt-architect ASSIGNED PW-0312. This endpoint used to
     * answer a signed-out caller with `{ error, detail }` -- a shape the
     * playback contract has no member for -- so the desktop forwarder, which
     * validates every backend body against `playbackSessionResponseSchema`,
     * correctly refused to relay it and produced an honest `unavailable`
     * instead. A viewer who needed to sign in was told to wait for a provider.
     *
     * The contract now has a fourth outcome, and this refusal is a member of
     * it. The forwarder parses it, `handler.ts` derives the same 401 from it on
     * the other side, and both targets answer one fact one way.
     */
    const response = await handleSessionRequest(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABLE_DEVICE }),
      { authenticate: SIGNED_OUT }
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const parsed = playbackSessionResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.outcome).toBe("unauthenticated");
    expect(parsed.data.reasons[0].code).toBe("not_authenticated");
    /* One sentence, shared with the web target, for all four ways a session
     * fails to verify -- so the wire cannot be read as an oracle. */
    expect(parsed.data.reasons[0].detail).toBe(NOT_AUTHENTICATED_DETAIL);
  });

  it("derives that 401 from the contract, not from a second opinion about it", async () => {
    /*
     * `unauthenticatedRefusal` takes its status from `playbackSessionHttpStatus`
     * while `authenticationRefusalStatus` still maps the reason for the other
     * two refusals. They agree today; this is what says so the day one moves.
     */
    const response = await handleSessionRequest(sessionRequest({}), { authenticate: SIGNED_OUT });
    expect(response.status).toBe(authenticationRefusalStatus("not_authenticated"));
  });

  it("does not reflect the upstream detail, which can quote a caller's header", async () => {
    const chatty = async () =>
      ({
        ok: false,
        reason: "development_identifier_malformed",
        detail: 'x-liberty-development-account was "<script>alert(1)</script>"'
      }) as const;
    const response = await handleSessionRequest(sessionRequest({}), { authenticate: chatty });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("script");
  });

  it("separates the operator's problem from the viewer's", async () => {
    /*
     * The statuses are `apps/web/src/lib/db/request-context.ts`'s, not new ones:
     * a signed-out request is 401 because "retry later" is false, and a missing
     * identity store is 503 because this deployment is missing a dependency.
     */
    expect(authenticationRefusalStatus("not_authenticated")).toBe(401);
    expect(authenticationRefusalStatus("authentication_not_configured")).toBe(503);
    expect(authenticationRefusalStatus("development_identifier_malformed")).toBe(400);

    const response = await handleSessionRequest(sessionRequest({}), { authenticate: NO_STORE });
    expect(response.status).toBe(503);
  });

  it("reports an authenticator that throws as an operator problem, without echoing it", async () => {
    const exploding = async () => {
      throw new Error("postgres://liberty:hunter2@db.internal:5432/liberty refused");
    };
    const outcome = await authenticateCaller(sessionRequest({}), exploding);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.reason).toBe("authentication_not_configured");
      expect(outcome.refusal.detail).not.toContain("hunter2");
      expect(outcome.refusal.detail).not.toContain("postgres");
    }
  });
});

describe("an authenticated caller reaches the application's own decision", () => {
  it("tells the decision who the caller is, so the identity store is read ONCE", async () => {
    /*
     * PW-0312 gave the application's resolving implementation an authentication
     * gate of its own -- it has to have one, because under the web target
     * nothing else authenticates. Under the desktop target that same code runs
     * HERE, behind this endpoint, which has already verified the caller from
     * headers alone. Handing the established identity inward is what keeps the
     * two gates from becoming two database reads per forwarded request.
     *
     * The assertion is on the SEAM rather than on a query count: the decision
     * receives the caller this endpoint authenticated, and nothing else.
     */
    const decide = vi.fn(
      async (_request: Request, _caller: AuthenticatedCaller) =>
        new Response("{}", { status: 200 })
    );
    await handleSessionRequest(sessionRequest({}), { authenticate: SIGNED_IN, decide });

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[1]).toEqual({
      account: { userId: "viewer-1", sessionId: "session-1" },
      detail: "a verified session"
    });
  });

  it("hands the request through untouched", async () => {
    const decide = vi.fn(async (request: Request) => {
      expect(await request.json()).toEqual({
        contentId: "aurora-fall",
        capabilities: CAPABLE_DEVICE
      });
      return new Response("{}", { status: 200 });
    });
    const response = await handleSessionRequest(
      sessionRequest({ contentId: "aurora-fall", capabilities: CAPABLE_DEVICE }),
      { authenticate: SIGNED_IN, decide }
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it("returns the decision's response as it is, with nothing added or removed", async () => {
    /*
     * "The same route contract, byte for byte." This service does not rewrite
     * a status, a header or a body on the success path: whatever the
     * application's envelope produced is what leaves here.
     */
    const decided = new Response(JSON.stringify({ outcome: "denied", reasons: [] }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-witness": "1" }
    });
    const response = await handleSessionRequest(sessionRequest({}), {
      authenticate: SIGNED_IN,
      decide: async () => decided
    });
    expect(response).toBe(decided);
  });

  it("answers a decision that throws with the contract's own unavailable shape", async () => {
    const response = await handleSessionRequest(sessionRequest({}), {
      authenticate: SIGNED_IN,
      decide: async () => {
        throw new Error("postgres://liberty:hunter2@db.internal/liberty");
      }
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { outcome: string; reasons: { code: string }[] };
    expect(body.outcome).toBe("unavailable");
    expect(body.reasons[0]?.code).toBe("provider_unavailable");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});

describe("what this service serves", () => {
  it("answers one product route and 404s everything else", async () => {
    for (const path of ["/", "/api/v1/catalog/home", "/api/v1/profiles", "/api/v1/playback/resolve"]) {
      const response = await routeRequest(new Request(`https://backend.invalid${path}`));
      expect(response.status, path).toBe(404);
    }
  });

  it("tells a wrong method it is wrong, rather than that the route is missing", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await routeRequest(
        new Request(`https://backend.invalid${SESSION_PATH}`, { method })
      );
      expect(response.status, method).toBe(405);
    }
  });

  it("has a liveness endpoint that reports nothing about its configuration", async () => {
    const response = await routeRequest(new Request(`https://backend.invalid${HEALTH_PATH}`));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true });
    for (const secret of ["postgres", "DATABASE_URL", "LIBERTY_", "provider", "tls"]) {
      expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("serves no route on anything but the method and the path", async () => {
    /*
     * Nothing a caller can send selects a different behaviour -- no header, no
     * query parameter, no body field. In particular there is nothing that
     * changes where resolution happens, which is the property
     * docs/DESKTOP_PLAYBACK.md section 8 rules about the desktop build,
     * restated on this side of the boundary.
     */
    const source = readFileSync(new URL("./router.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/headers\.get/);
    expect(source).not.toMatch(/searchParams/);
    /* Non-vacuity: it is still the router. */
    expect(source).toContain("SESSION_PATH");
    expect(source).toContain("request.method");
  });
});

describe("no second implementation of the decision, and no credential in the source", () => {
  it("takes the envelope from the application rather than composing its own", async () => {
    /*
     * `e2e/src/backend-stub.mjs` argues the general case about itself: a stub
     * that reimplemented the decision "would be a second opinion about it". The
     * same holds with more force here. This service imports
     * `handlePlaybackSessionRequest`, so there is ONE of it in this repository
     * and no second copy to drift from the first.
     */
    const source = readFileSync(new URL("./session-endpoint.ts", import.meta.url), "utf8");
    expect(source).toContain('from "@liberty/web/playback-session/handler"');
  });

  it("composes no resolution of its own anywhere in this service", async () => {
    /*
     * The provider capability LIVES here -- that is the point of the section-8
     * ruling -- but it lives here by being reached through the one
     * implementation, not by this service ranking or resolving for itself. A
     * direct value import of the ranking engine or the provider SDK in this
     * source tree would be the beginning of the second opinion.
     */
    for (const file of ["session-endpoint.ts", "router.ts", "server.ts", "main.ts", "authentication.ts", "config.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/^import [^;]*from "@liberty\/(media-engine|provider-sdk)"/m);
    }
  });

  it("names no provider credential anywhere in its own source", async () => {
    /*
     * The ruling says credentials live HERE and never on the desktop. "Here"
     * means this process's environment at runtime, never this repository: a
     * key, a client secret or a signing key written into source is one that
     * ships in the bundle, and the bundle is an artifact.
     */
    for (const file of ["session-endpoint.ts", "router.ts", "server.ts", "main.ts", "authentication.ts", "config.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/api[_-]?key|client[_-]?secret|signing[_-]?key|bearer\s*[:=]/i);
    }
  });
});
