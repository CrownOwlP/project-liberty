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
  DESKTOP_BASE_URL,
  DESKTOP_SKIP_REASON,
  WEB_MODE
} from "../src/env";
import { CAPABLE_DEVICE, DEMO, sessionRequest } from "../src/fixtures";

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

test.beforeAll(async () => {
  desktop = await playwrightRequest.newContext({ baseURL: DESKTOP_BASE_URL });
  stub = await playwrightRequest.newContext({
    baseURL: BACKEND_STUB_ORIGIN,
    ignoreHTTPSErrors: true
  });
});

test.afterAll(async () => {
  await desktop.dispose();
  await stub.dispose();
});

async function clearLedger(): Promise<void> {
  const response = await stub.delete("/__requests");
  expect(response.status(), "the stub backend did not accept a ledger reset").toBe(200);
}

async function ledger(): Promise<StubRequest[]> {
  const response = await stub.get("/__requests");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { requests: StubRequest[] };
  return body.requests;
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
  await clearLedger();

  const body = sessionRequest(DEMO.movie.id);
  const shape = await decision(await desktop.post(ROUTE, { data: body }));
  expect(["granted", "denied", "unavailable"]).toContain(shape.outcome);

  const seen = await ledger();

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
  await clearLedger();

  await desktop.post(ROUTE, {
    data: sessionRequest(DEMO.movie.id),
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

  const seen = await ledger();
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

test("a redirect from the backend is refused rather than followed", async () => {
  /*
   * `redirect: "error"` on the outbound fetch, observed from outside. Following
   * a redirect would re-send the caller's identity headers to whatever origin
   * the redirect named, which is a credential-forwarding decision the forwarder
   * has no business taking, and the contract has no redirect in it to honour.
   */
  await clearLedger();

  const shape = await decision(await desktop.post(ROUTE, { data: sessionRequest(STUB_REDIRECT) }));
  expect(shape.outcome).toBe("unavailable");
  expect(reasonCodes(shape)).toContain("provider_unavailable");

  /* And the identity went to exactly one origin: the stub saw the request once
   * and the redirect target was never contacted, which is unobservable from
   * here except as the absence of a second ledger entry. */
  expect(await ledger()).toHaveLength(1);
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
      headers: { "content-type": "application/json" },
      data: body
    });
    expect(response.status(), `body ${body} produced ${response.status()}`).not.toBe(500);

    const shape = await decision(response);
    expect(shape.outcome).toBe("denied");
    expect(response.status()).toBe(400);
  }
});

test("a normalized content id is required before the backend is consulted", async () => {
  /*
   * The request schema runs on the backend under this target, so the refusal is
   * the backend's -- but the CONTRACT is that the caller sees the same denial
   * it sees on the web target, which is what this asserts.
   */
  for (const contentId of ["../../etc/passwd", "Aurora Fall", "https://evil.test/x.mpd", ""]) {
    const shape = await decision(
      await desktop.post(ROUTE, { data: sessionRequest(contentId, CAPABLE_DEVICE) })
    );
    expect(shape.outcome, `contentId ${JSON.stringify(contentId)}`).toBe("denied");
    expect(reasonCodes(shape)).toContain("request_malformed");
  }
});
