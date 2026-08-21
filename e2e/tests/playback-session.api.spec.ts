import { expect, test } from "@playwright/test";
import type { APIResponse } from "@playwright/test";
import {
  expectedStatus,
  isRecord,
  playbackSessionViolations,
  reasonCodes,
  type PlaybackSessionResponseShape
} from "../src/contract";
import { EXPECTED_MEDIA_ORIGIN, MANAGES_SERVER, WEB_MODE } from "../src/env";
import { CAPABLE_DEVICE, DEMO, TINY_DEVICE, sessionRequest } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * POST /api/v1/playback/session - the discriminated union, end to end
 *
 * This endpoint is the rights-enforcement point, and the property that has to
 * survive every future change to it is the SHAPE: one of three outcomes, and a
 * non-empty reason trail on every one of them. So every test in this file
 * checks the shape first and its own subject second. A response that lost its
 * trail while producing the right outcome is still a regression, and it is
 * exactly the regression a test that only looked at `outcome` would miss.
 * ---------------------------------------------------------------------- */

const ROUTE = "/api/v1/playback/session";

/** Reads a response and asserts the union holds before anything else reads it. */
async function decision(response: APIResponse): Promise<PlaybackSessionResponseShape> {
  const body: unknown = await response.json();

  /* Reported as a list so one run names every violation. */
  expect(playbackSessionViolations(body), `response body: ${JSON.stringify(body)}`).toEqual([]);

  const shape = body as PlaybackSessionResponseShape;

  /* The status is DERIVED from the outcome on the server. Checking it here
   * against an independently written mapping is what stops the wire status and
   * the decision drifting apart -- a 200 carrying a denial is a client that
   * plays nothing and reports nothing. */
  expect(response.status()).toBe(expectedStatus(shape));

  /* Per-viewer, per-device and time-bounded. A shared cache holding one would
   * serve one viewer's session to another. */
  expect(response.headers()["cache-control"]).toContain("no-store");

  return shape;
}

test("a well-formed request produces a well-formed decision", async ({ request }) => {
  const shape = await decision(
    await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) })
  );
  expect(["granted", "denied", "unavailable"]).toContain(shape.outcome);
});

test("the outcome matches what this deployment is configured to resolve", async ({ request }) => {
  test.skip(!MANAGES_SERVER, "Only this harness knows how a server it started was configured.");

  const shape = await decision(
    await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) })
  );

  if (WEB_MODE === "production") {
    /*
     * NOT A DEGRADED PASS. A production build resolves no candidates on
     * purpose: no provider registry is wired in yet, and serving fixtures from
     * a hosted deployment would publish fabricated `owned` rights for files
     * that do not exist. `provider_not_configured` names the operator's remedy;
     * an empty candidate list would not. If this ever starts answering
     * `granted` under a production build, a fixture has escaped into a shipped
     * artifact and that is a rights incident.
     */
    expect(shape.outcome).toBe("unavailable");
    expect(reasonCodes(shape)).toContain("provider_not_configured");
  } else {
    expect(shape.outcome).toBe("granted");
    expect(reasonCodes(shape)[0]).toMatch(/^session_issued/);
  }
});

test("a granted session publishes candidates only on the configured media origin", async ({
  request
}) => {
  const shape = await decision(
    await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) })
  );
  test.skip(shape.outcome !== "granted", `Outcome was ${shape.outcome}; there is no candidate list.`);
  test.skip(
    EXPECTED_MEDIA_ORIGIN === null,
    "Testing an external deployment whose media origin this harness was not told. " +
      "Set LIBERTY_E2E_MEDIA_ORIGIN to assert it."
  );

  const session = isRecord(shape.session) ? shape.session : {};
  const candidates = Array.isArray(session["candidates"]) ? session["candidates"] : [];
  const expected = new URL(EXPECTED_MEDIA_ORIGIN as string).origin;

  const offenders = candidates
    .filter(isRecord)
    .map((candidate) => String(candidate["uri"]))
    .filter((uri) => {
      try {
        return new URL(uri).origin !== expected;
      } catch {
        return true;
      }
    });

  /* The one assertion that would catch a stream of unknown provenance being
   * published to a player. Every URL in a session was produced server-side by
   * something that established authorization first; an origin nobody
   * configured means something else produced one. */
  expect(offenders).toEqual([]);

  /* Resume-from-progress is PL-0403's and it does not exist yet. `null` means
   * "engine default" -- the beginning for VOD, the live edge for live -- and it
   * is a different claim from `0`. When PL-0403 lands this assertion is the
   * thing that has to be updated deliberately. */
  expect(session["startAtSeconds"]).toBeNull();
});

test("an unsatisfiable device is unavailable, not denied, and says why per candidate", async ({
  request
}) => {
  const shape = await decision(
    await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id, TINY_DEVICE) })
  );

  /* Keyed on the reason rather than on `WEB_MODE`, so this holds against an
   * external deployment too: eligibility is only reachable once something
   * resolved candidates at all. */
  test.skip(
    reasonCodes(shape).includes("provider_not_configured"),
    "This deployment resolves no candidates, so eligibility is never reached."
  );

  /*
   * The remedy distinction, and it is the reason this is a union rather than a
   * boolean. Nothing here is a rights refusal: every candidate carried a basis
   * we may play from and lost on a ceiling. Reporting it as `denied` would tell
   * a viewer they are not entitled to something they are, and a client would
   * stop retrying a device problem that a better device would fix.
   */
  expect(shape.outcome).toBe("unavailable");
  expect(reasonCodes(shape)).toContain("no_playable_candidate");
  expect(reasonCodes(shape)).toContain("resolution_exceeds_capability");

  const attributed = shape.reasons.filter(
    (reason) => reason.code === "resolution_exceeds_capability"
  );
  /* Every candidate-level reason names its candidate. A trail that cannot say
   * WHICH stream was dropped is not a trail. */
  expect(attributed.every((reason) => typeof reason.candidateId === "string")).toBe(true);
});

test("the same request twice produces the same decision", async ({ request }) => {
  /*
   * Determinism as correctness. Six order-dependence defects so far, and the
   * session response is documented as a function of the SET of resolved
   * candidates rather than of the order a resolver returned them in. Two
   * fields legitimately differ between calls -- the session id, which must be
   * unguessable, and the expiry, which is a clock reading -- so they are
   * removed rather than the comparison being weakened to a subset check.
   */
  const first = await decision(await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) }));
  const second = await decision(await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) }));

  expect(withoutPerCallFields(second)).toEqual(withoutPerCallFields(first));
});

function withoutPerCallFields(shape: PlaybackSessionResponseShape): unknown {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(shape));
  const session = clone["session"];
  if (isRecord(session)) {
    delete session["sessionId"];
    delete session["expiresAt"];
  }
  return clone;
}

test("a malformed body is a decision, never a stack trace", async ({ request }) => {
  for (const body of ["not json at all", "7", "null", "[]"]) {
    const response = await request.post(ROUTE, {
      headers: { "content-type": "application/json" },
      data: body
    });

    /* An endpoint that can throw is an endpoint whose failure mode is a 500
     * with no reason trail, which is what invariant 4 exists to prevent. */
    expect(response.status(), `body ${body} produced ${response.status()}`).not.toBe(500);

    const shape = await decision(response);
    expect(shape.outcome).toBe("denied");
    expect(response.status()).toBe(400);
  }
});

test("the session route does not answer a GET with a session", async ({ request }) => {
  /* Deliberately weak, and deliberately present. Whether the framework answers
   * an undeclared method with 405 or something else is the framework's
   * business; that this route never hands out a session to a method that
   * carries no body is ours. */
  const response = await request.get(ROUTE);
  expect(response.status()).not.toBe(200);
});

test("capabilities are required, and the refusal explains itself", async ({ request }) => {
  const shape = await decision(
    await request.post(ROUTE, { data: { contentId: DEMO.movie.id } })
  );
  expect(shape.outcome).toBe("denied");
  expect(reasonCodes(shape)).toContain("request_malformed");
});

test("a normalized content id is required before any resolver is consulted", async ({ request }) => {
  for (const contentId of ["../../etc/passwd", "Aurora Fall", "https://evil.test/x.mpd", ""]) {
    const shape = await decision(
      await request.post(ROUTE, { data: sessionRequest(contentId, CAPABLE_DEVICE) })
    );
    expect(shape.outcome, `contentId ${JSON.stringify(contentId)}`).toBe("denied");
    expect(reasonCodes(shape)).toContain("request_malformed");
  }
});
