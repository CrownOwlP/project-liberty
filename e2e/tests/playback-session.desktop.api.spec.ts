import { randomUUID } from "node:crypto";

import { expect, request as playwrightRequest, test } from "@playwright/test";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import {
  collectStrings,
  expectedStatus,
  isRecord,
  playbackSessionViolations,
  reasonCodes,
  type PlaybackSessionResponseShape
} from "../src/contract";
import {
  BACKEND_STUB_ORIGIN,
  BASE_URL,
  DESKTOP_BASE_URL,
  DESKTOP_SKIP_REASON,
  IDENTITY_MECHANISM,
  PLAYBACK_DECISION_SKIP_REASON,
  WEB_MODE
} from "../src/env";
import { CAPABLE_DEVICE, DEMO, sessionRequest } from "../src/fixtures";
import { establishSession, type SessionHeaders } from "../src/identity";

/* -------------------------------------------------------------------------
 * THE DESKTOP BUILD TARGET, END TO END (PL-0501, round 45, correction 4)
 *
 * WRITTEN BY PL-0501 INSIDE PL-0701's DECLARED SURFACE, which is BACKLOG,
 * unowned and blocked behind PL-0501 -- so it could not be claimed to write
 * this. The reviewer authorised the overlap in advance; PL-0501's
 * `surfaceWidenedOnReview` record carries the reasoning, and PL-0701 inherits
 * these files.
 *
 * WHAT ROUND 44 COULD NOT PROVE, IN ITS OWN GATE'S WORDS: "there is no
 * end-to-end run against the desktop target, no stub backend, and therefore no
 * proof that a forwarded request reaches a backend and returns; everything
 * asserted about the forwarder is in-process against an injected fetch."
 *
 * THIS FILE IS THAT PROOF, and it is deliberately about the FORWARDING rather
 * than about the decision. The decision is the backend's; what has to be shown
 * here is that the desktop build has no opinion of its own -- that the answer a
 * viewer gets came over the wire from an authenticated backend and not from a
 * resolver running on the machine they administer.
 *
 * THE SHARPEST ASSERTION IN THE FILE IS `the backend's decision wins`. Under a
 * development build the fixture provider GRANTS a session for any normalized
 * content id, so a desktop build that resolved locally would grant. The stub is
 * told to deny for one reserved id. If the desktop build denies, it did not
 * resolve -- which is a runtime statement of the property
 * `apps/web/src/app/api/v1/playback/build-target.test.ts` makes about the
 * module graph, arrived at from the other end.
 * ---------------------------------------------------------------------- */

const ROUTE = "/api/v1/playback/session";

/** Reserved ids the stub answers itself instead of relaying. */
const STUB_DENIED = "stub-denied";
const STUB_UNAVAILABLE = "stub-unavailable";
const STUB_OFF_CONTRACT = "stub-off-contract";
const STUB_UNAUTHENTICATED = "stub-unauthenticated";
const STUB_REDIRECT = "stub-redirect";

test.skip(DESKTOP_SKIP_REASON !== null, DESKTOP_SKIP_REASON ?? "");

test.beforeEach(() => {
  /* Both axes on every result. "playback-session.desktop.api.spec.ts passed" is
   * a third of a statement otherwise -- the same argument the web spec makes
   * about `WEB_MODE` alone. */
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
  test.info().annotations.push({ type: "build-target", description: "desktop" });
});

interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * A client for the desktop-target server and one for the stub's own ledger.
 *
 * TWO CONTEXTS RATHER THAN THE `request` FIXTURE, because the stub speaks
 * https with a certificate minted for this run and Playwright's default context
 * would refuse it. `ignoreHTTPSErrors` is set on the LEDGER client only: the
 * server under test verifies the certificate properly through
 * `NODE_EXTRA_CA_CERTS`, which is the check that matters, and relaxing it for
 * this suite's own bookkeeping client does not touch it.
 */
let desktop: APIRequestContext;
let stub: APIRequestContext;

/* -------------------------------------------------------------------------
 * A SESSION MINTED ON THE WEB ORIGIN AND PRESENTED TO THE DESKTOP TARGET
 * (PW-0312)
 *
 * This is PW-0401's "forwards an authenticated caller identity", observed. The
 * cookie goes to the desktop server, which passes it to its backend through the
 * `IDENTITY_HEADERS` allowlist -- an allowlist and not a copy, precisely so the
 * next header somebody adds is not forwarded by default -- and the backend
 * authenticates it against the same database the web origin issued it from.
 * Liberty uses DATABASE sessions (PL-0401), so what crosses is a pointer and the
 * row is the authority.
 *
 * WITHOUT IT, every test below whose subject is the FORWARDER would be a test
 * of the authentication gate instead: the desktop target now refuses an
 * anonymous request in front of everything this file measures.
 *
 * Empty under `development` and under a production run with no identity system.
 * ---------------------------------------------------------------------- */
let SIGNED_IN: SessionHeaders = {};

test.beforeAll(async () => {
  desktop = await playwrightRequest.newContext({ baseURL: DESKTOP_BASE_URL });
  stub = await playwrightRequest.newContext({
    baseURL: BACKEND_STUB_ORIGIN,
    ignoreHTTPSErrors: true
  });

  if (IDENTITY_MECHANISM !== "database-session") return;
  const web = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    SIGNED_IN = await establishSession(web);
  } finally {
    await web.dispose();
  }
});

/** A signed-in request's headers, plus any the caller needs of its own. */
function signedIn(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, ...SIGNED_IN };
}

test.afterAll(async () => {
  await desktop.dispose();
  await stub.dispose();
});

/* =========================================================================
 * THE LEDGER, AND WHY IT IS READ BY CORRELATION RATHER THAN CLEARED (PL-0713)
 * =========================================================================
 *
 * THERE USED TO BE A `clearLedger()` HERE AND IT WAS THE DEFECT. The stub
 * keeps ONE ledger for its whole process. Three tests used to wipe it and
 * then assert it held exactly their own request. `playwright.config.ts` sets
 * `fullyParallel: true`, which splits tests WITHIN a file across workers —
 * and this very file contains a test that deliberately forwards four more
 * requests to the same backend. On a two-core machine Playwright uses one
 * worker, they serialise, and everything passes. On a GitHub runner they
 * interleave: CI run 37007312900 failed three assertions here with "Expected
 * length: 1, Received length: 0" and "Received length: 2".
 *
 * TWO REMEDIES WERE TRIED AND MEASURED BEFORE THIS ONE, and both are recorded
 * because the measurements are the argument:
 *
 *   - SERIALISING THE FILE (`test.describe.configure({ mode: "default" })`).
 *     The file alone went green at 4 and 8 workers; the whole `api` project
 *     at 4 workers still failed. It does not hold under a `fullyParallel`
 *     project, and it would have been the wrong shape anyway — scheduling is
 *     not isolation, it is the absence of a collision this time.
 *   - FILTERING BY CONTENT ID ALONE. Deterministically worse: two failures at
 *     1, 4 and 8 workers alike, because `aurora-fall` appears in SEVEN
 *     requests in this file and `northstar` in two.
 *
 * WHAT IS DONE INSTEAD: every flow that asserts on the ledger carries a
 * CORRELATION IDENTITY unique to that test invocation, and reads only its own
 * entries. Nothing clears shared state, so there is nothing for a neighbour
 * to clear out from under it, and a run with `--repeat-each` cannot collide
 * with itself either.
 *
 * TWO MECHANISMS, AND THE SPLIT IS FORCED BY WHERE VALIDATION HAPPENS:
 *
 *   1. A RESERVED CONTENT ID (`correlatedContentId`) for flows that fall
 *      through the stub to the real resolver. This is the mechanism the stub
 *      ALREADY uses for test-only identities — `stub-denied`,
 *      `stub-unavailable`, `stub-redirect` are reserved content ids and
 *      nothing else — so it invents nothing.
 *   2. A CORRELATION FIELD IN THE BODY (`correlationField`) for flows that hit
 *      one of those canned ids, where the content id is fixed by the stub and
 *      cannot also carry the identity. This is safe for exactly those flows
 *      and ONLY those: `playbackSessionRequestSchema` is `.strict()` at both
 *      levels on purpose, so an extra field would be refused as malformed by
 *      the real route — but a canned id is answered by the stub from a literal
 *      and never reaches that schema. Using it on a proxied flow would convert
 *      a real decision into a malformed denial, which is why it is not used
 *      there.
 *
 * PRODUCTION IS UNTOUCHED. Nothing in the application sends either; the
 * forwarder relays bytes it does not read, and the header allowlist — which
 * `only the identity headers leave the machine` asserts and which must not be
 * loosened to carry a test identity — is unchanged.
 * ====================================================================== */

/** A content id reserved to one test invocation. See the header. */
function correlatedContentId(flow: string): string {
  return `pl0713-${flow}-${randomUUID()}`;
}

/** A correlation field for a flow whose content id is fixed by the stub. */
function correlationField(): { readonly __pl0713CorrelationId: string } {
  return { __pl0713CorrelationId: randomUUID() };
}

/**
 * The stub requests belonging to one correlation identity, and nothing else.
 *
 * Matches on the content id OR the body field, so one reader serves both
 * mechanisms. A body that is not JSON at all — the malformed-body test
 * forwards four of those — belongs to no identity and is nobody's evidence.
 */
async function ledgerFor(identity: string): Promise<StubRequest[]> {
  const response = await stub.get("/__requests");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { requests: StubRequest[] };
  return body.requests.filter((entry) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.body);
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return false;
    return parsed["contentId"] === identity || parsed["__pl0713CorrelationId"] === identity;
  });
}

/** Reads a response and asserts the union holds before anything else reads it. */
async function decision(response: APIResponse): Promise<PlaybackSessionResponseShape> {
  const body: unknown = await response.json();
  expect(playbackSessionViolations(body), `response body: ${JSON.stringify(body)}`).toEqual([]);

  const shape = body as PlaybackSessionResponseShape;

  /*
   * THE STATUS IS DERIVED FROM THE OUTCOME ON THE SERVER, and on THIS target it
   * is derived from the outcome the BACKEND sent -- `handler.ts` runs
   * `playbackSessionHttpStatus` over the relayed decision and the forwarder
   * deliberately never reads the backend's own status. So a stub that answered
   * 200 with a denial still has to produce a 403 here, and this line is what
   * says so.
   */
  expect(response.status()).toBe(expectedStatus(shape));
  expect(response.headers()["cache-control"]).toContain("no-store");

  return shape;
}

test("a forwarded request actually reaches the backend stub", async () => {
  /* A CONTENT ID BELONGING TO THIS INVOCATION ALONE (PL-0713). It falls
   * through the stub to the real resolver exactly as a catalog id would --
   * what it answers is not this test's subject; that the request ARRIVED is. */
  const contentId = correlatedContentId("forwarded");
  const body = sessionRequest(contentId);
  const shape = await decision(
    await desktop.post(ROUTE, { data: body, headers: signedIn() })
  );
  expect(["granted", "denied", "unavailable"]).toContain(shape.outcome);

  const seen = await ledgerFor(contentId);

  /*
   * ONE REQUEST, NOT "AT LEAST ONE". A forwarder that retried, or that fanned
   * out, would be taking a decision it has no business taking -- and a
   * duplicated session request against a real backend is a duplicated
   * authorization.
   */
  expect(seen).toHaveLength(1);
  const forwarded = seen[0] as StubRequest;

  expect(forwarded.method).toBe("POST");
  /*
   * THE SAME PATH, COMPOSED FROM A CONSTANT. `PLAYBACK_SESSION_PATH` in the
   * forwarder is a literal rather than the inbound request's pathname,
   * precisely so a caller cannot steer the proxy onto another backend route.
   * This is that property observed from outside the process.
   */
  expect(forwarded.path).toBe(ROUTE);
  /*
   * THE BYTES AS GIVEN. The forwarder relays `request.text()` rather than
   * parsing and re-serialising, so that deciding what the request said happens
   * in exactly one place. A normalised body here would mean two pieces of code
   * can disagree about a malformed request.
   */
  expect(JSON.parse(forwarded.body)).toEqual(body);
});

test("the backend's decision wins over anything this machine could have resolved", async ({
  request
}) => {
  /*
   * THE CENTRAL ASSERTION OF THE WHOLE ROUND, and it is a difference rather
   * than an absolute: the same request, to the two targets, gets two answers,
   * and the desktop one is the backend's.
   *
   * Under `development` the WEB target grants -- the fixture provider resolves
   * three candidates for any normalized id. Under `production` it answers
   * `unavailable` / `provider_not_configured`. Neither is `denied` /
   * `rights_not_established`, which is what the stub is told to say. So a
   * desktop build that produced the stub's answer cannot have resolved
   * anything locally, on either build.
   */
  const shape = await decision(await desktop.post(ROUTE, { data: sessionRequest(STUB_DENIED) }));

  expect(shape.outcome).toBe("denied");
  expect(reasonCodes(shape)).toContain("rights_not_established");

  const web = await decision(await request.post(ROUTE, { data: sessionRequest(STUB_DENIED) }));
  expect(
    web.outcome,
    "the web target produced the stub's answer, so this test proves nothing"
  ).not.toBe("denied");

  /*
   * AND NOTHING THE FIXTURE PROVIDER COULD HAVE MADE IS IN THE DESKTOP BODY.
   * Paired against the web target under `development`, where those strings must
   * be present -- an absence check with no counterpart is an absence check that
   * can pass because nothing was ever produced.
   */
  const desktopStrings = collectStrings(shape).join("\n");
  for (const artefact of ["720p.mp4", "master.m3u8", "manifest.mpd", `${DEMO.movie.id}-hls`]) {
    expect(desktopStrings, `the desktop target published ${artefact}`).not.toContain(artefact);
  }

  if (WEB_MODE === "development") {
    const granted = await decision(
      await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) })
    );
    expect(collectStrings(granted).join("\n")).toContain("master.m3u8");
  }
});

test("only the identity headers leave the machine", async () => {
  /*
   * §8: the proxy "forwards an authenticated caller identity -- the session or
   * profile identity the request already carries" and "never receives a
   * provider credential". `IDENTITY_HEADERS` is an ALLOWLIST rather than a
   * denylist for the stated reason that the one header this build must never
   * send is one nobody has thought of yet -- so this test sends one nobody has
   * thought of and requires it not to arrive.
   */
  const contentId = correlatedContentId("identity-headers");

  await desktop.post(ROUTE, {
    data: sessionRequest(contentId),
    headers: {
      cookie: "liberty_session=e2e",
      authorization: "Bearer e2e-token",
      "x-liberty-development-account": "e2e-desktop",
      "x-liberty-development-session": "e2e-desktop-session",
      /* Neither of these is on the allowlist. The first stands in for a header
       * a later change adds without thinking; the second stands in for the
       * sidecar's own loopback bearer token, which §7 gives it and which means
       * nothing to the backend. */
      "x-liberty-not-on-the-allowlist": "must-not-arrive",
      "x-liberty-sidecar-token": "must-not-arrive"
    }
  });

  const seen = await ledgerFor(contentId);
  expect(seen).toHaveLength(1);
  const headers = (seen[0] as StubRequest).headers;

  expect(headers["cookie"]).toBe("liberty_session=e2e");
  expect(headers["authorization"]).toBe("Bearer e2e-token");
  expect(headers["x-liberty-development-account"]).toBe("e2e-desktop");
  expect(headers["x-liberty-development-session"]).toBe("e2e-desktop-session");

  expect(headers["x-liberty-not-on-the-allowlist"]).toBeUndefined();
  expect(headers["x-liberty-sidecar-token"]).toBeUndefined();
});

test("a backend body outside the contract is an honest unavailable, not a pass-through", async () => {
  /*
   * The forwarder validates the backend's body against
   * `playbackSessionResponseSchema` before it becomes this route's answer. A
   * forwarder that echoed bytes it had not understood would be a hole in the
   * contract §8 says is preserved exactly -- and the client would receive
   * something no version of this API has ever published.
   */
  const shape = await decision(
    await desktop.post(ROUTE, { data: sessionRequest(STUB_OFF_CONTRACT) })
  );

  expect(shape.outcome).toBe("unavailable");
  expect(reasonCodes(shape)).toContain("provider_unavailable");
  expect(isRecord(shape.session)).toBe(false);
});

test("a signed-out backend refusal reaches the viewer as sign-in, not as an outage", async () => {
  /*
   * THE CORRECTIVE gpt-architect ASSIGNED PW-0312, END TO END ON THIS TARGET.
   *
   * Before the contract carried a fourth outcome, the authenticated backend's
   * 401 was `{ error, detail }` -- not a member of the union -- so the test
   * above, which is the forwarder refusing to relay a body it cannot parse,
   * was the code path a signed-out desktop viewer actually took. They were told
   * the playback service was unavailable. The remedy was theirs all along.
   *
   * What this asserts is the pair of facts that makes the state ACTIONABLE:
   * the outcome is `unauthenticated` rather than `unavailable`, and the status
   * is 401 rather than 503 -- derived here from the relayed decision, not
   * echoed from the stub.
   */
  const shape = await decision(
    await desktop.post(ROUTE, { data: sessionRequest(STUB_UNAUTHENTICATED) })
  );

  expect(shape.outcome).toBe("unauthenticated");
  expect(reasonCodes(shape)).toEqual(["not_authenticated"]);
  /* The collapse the ruling forbids by name, asserted as an absence. */
  expect(reasonCodes(shape)).not.toContain("provider_unavailable");
  expect(isRecord(shape.session)).toBe(false);
});

test("a redirect from the backend is refused rather than followed", async () => {
  /*
   * `redirect: "error"` on the outbound fetch, observed from outside. Following
   * a redirect would re-send the caller's identity headers to whatever origin
   * the redirect named, which is a credential-forwarding decision the forwarder
   * has no business taking, and the contract has no redirect in it to honour.
   */
  /* THE CONTENT ID IS FIXED BY THE STUB here -- `stub-redirect` is what makes
   * it answer 302 -- so the correlation identity rides in the body instead.
   * Safe precisely because a canned id is answered from a literal and never
   * reaches the strict request schema; see the ledger header. */
  const correlation = correlationField();
  const shape = await decision(
    await desktop.post(ROUTE, { data: { ...sessionRequest(STUB_REDIRECT), ...correlation } })
  );
  expect(shape.outcome).toBe("unavailable");
  expect(reasonCodes(shape)).toContain("provider_unavailable");

  /*
   * THE STUB SAW THIS FLOW EXACTLY ONCE: the forwarder did not retry and did
   * not fan out after being handed a 302.
   *
   * A CORRECTION TO WHAT THIS LINE USED TO CLAIM. Its comment said the absence
   * of a second ledger entry is how "the redirect target was never contacted"
   * is observed. It is not: `stub-redirect` redirects to
   * `https://127.0.0.1:1/elsewhere`, a different origin that is not this stub,
   * so the ledger could never have recorded a followed redirect either way.
   * What proves non-following is the OUTCOME asserted above -- an `unavailable`
   * carrying `provider_unavailable`, which is what the forwarder answers when
   * it refuses the redirect rather than chasing it. The ledger count is the
   * no-retry property, which is worth asserting on its own.
   */
  expect(await ledgerFor(correlation.__pl0713CorrelationId)).toHaveLength(1);
});

test("an unavailable backend is an unavailable session, with a reason", async () => {
  const shape = await decision(
    await desktop.post(ROUTE, { data: sessionRequest(STUB_UNAVAILABLE) })
  );
  expect(shape.outcome).toBe("unavailable");
  expect(reasonCodes(shape)).toContain("provider_unavailable");
  /*
   * §8 requires this by name: "an offline or degraded-network desktop cannot
   * resolve at all -- the failure has to be surfaced as an honest unavailable
   * outcome rather than as an empty candidate list."
   */
  expect(shape.reasons.length).toBeGreaterThan(0);
});

test("a malformed body is refused before it is forwarded to anybody", async () => {
  test.skip(PLAYBACK_DECISION_SKIP_REASON !== null, PLAYBACK_DECISION_SKIP_REASON ?? "");
  /*
   * The forwarder relays the bytes as given, so a malformed body IS forwarded
   * and the backend's route answers it -- which is the stated design: deciding
   * what the request said is the resolving implementation's job, and under this
   * target that implementation runs on the backend. What must hold on the wire
   * is the same thing that holds on the web target: a decision, never a stack
   * trace.
   */
  for (const body of ["not json at all", "7", "null", "[]"]) {
    const response = await desktop.post(ROUTE, {
      headers: signedIn({ "content-type": "application/json" }),
      data: body
    });
    expect(response.status(), `body ${body} produced ${response.status()}`).not.toBe(500);

    const shape = await decision(response);
    expect(shape.outcome).toBe("denied");
    expect(response.status()).toBe(400);
  }
});

test("a normalized content id is required before the backend is consulted", async () => {
  test.skip(PLAYBACK_DECISION_SKIP_REASON !== null, PLAYBACK_DECISION_SKIP_REASON ?? "");
  /*
   * The request schema runs on the backend under this target, so the refusal is
   * the backend's -- but the CONTRACT is that the caller sees the same denial
   * it sees on the web target, which is what this asserts.
   */
  for (const contentId of ["../../etc/passwd", "Aurora Fall", "https://evil.test/x.mpd", ""]) {
    const shape = await decision(
      await desktop.post(ROUTE, {
        data: sessionRequest(contentId, CAPABLE_DEVICE),
        headers: signedIn()
      })
    );
    expect(shape.outcome, `contentId ${JSON.stringify(contentId)}`).toBe("denied");
    expect(reasonCodes(shape)).toContain("request_malformed");
  }
});
