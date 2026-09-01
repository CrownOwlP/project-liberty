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
    /*
     * The EXACT code, not `/^session_issued/`. That prefix matched both
     * `session_issued` and `session_issued_unverified_compatibility`, which are
     * the two halves of the distinction PL-0301 exists to preserve: the fixture
     * provider states `null` for every media fact because nothing has opened
     * those files, so a session over it can only ever be issued with UNVERIFIED
     * compatibility. `session_issued` here would mean a fixture had started
     * claiming codecs again -- the exact regression whose previous form labelled
     * a session `verified` for a file nobody had read -- and the loose prefix
     * would have reported that as a pass.
     */
    expect(reasonCodes(shape)[0]).toBe("session_issued_unverified_compatibility");
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

/* -------------------------------------------------------------------------
 * WHAT THIS TEST USED TO ASSERT, AND WHY WHAT REPLACES IT IS A DIFFERENT
 * ASSERTION RATHER THAN THE SAME ONE RELOCATED.
 *
 * It sent `TINY_DEVICE` (`maxHeight: 144`) and required `unavailable` plus a
 * per-candidate `resolution_exceeds_capability`. It passed because the fixture
 * candidates stated `height: 720`/`1080` -- numbers read off filenames the
 * fixture module itself chose, about files nobody had ever opened. PL-0301
 * removed them: every media fact a fixture cannot measure is now `null`, and
 * `ranking.ts` deliberately does NOT compare a `null` height against a ceiling,
 * because refusing a stream over a measurement that does not exist invents a
 * fact in the same way the old `h264`/`aac` claim did. So the engine is right
 * and the old expectation is stale.
 *
 * REJECTED: MOVING IT TO `POST /api/v1/playback/resolve`. That route accepts
 * caller-supplied candidates precisely so eligibility can be exercised with
 * STATED facts, so it looks like the natural new home. Three things against it,
 * in order of weight:
 *
 *   - the half of the assertion with teeth cannot be made there. When nothing
 *     is eligible that route answers `422 { error: "no_playable_candidate",
 *     detail: "no_eligible_candidates" }` and drops `decision.rejected` on the
 *     floor, so neither the `resolution_exceeds_capability` code nor the
 *     candidate id it was attributed to appears anywhere in the body. Only a
 *     MIXED list -- one candidate over the ceiling, one under it -- carries the
 *     rejection list, and then the test is really about a 200;
 *   - the property is already asserted, whole, where candidates can be
 *     injected: `issue-session.test.ts`, "never grants a session with no
 *     candidates", requires `unavailable`, `no_playable_candidate`, and
 *     `resolution_exceeds_capability` attributed to the tall candidate by id.
 *     An e2e copy that proves less is not coverage, it is a second place to
 *     update;
 *   - `/api/v1/playback/resolve` answers 404 on every build that ships, so the
 *     copy would run only under `LIBERTY_E2E_WEB_MODE=development` and would be
 *     a skip line in every run CI is shaped like.
 *
 * WHAT REPLACES IT IS THE THING ONLY THIS LAYER CAN SEE: that the resolver a
 * real deployment is wired to states nothing it has not measured. A unit test
 * injects its candidates and so can never notice a fixture provider reacquiring
 * invented ones. This test posts a ceiling no real stream would clear and
 * requires the session to be granted anyway, unverified -- which fails loudly
 * the moment a fixture starts stating a height or a codec again.
 * ---------------------------------------------------------------------- */
test("a device ceiling cannot refuse a candidate that states no height", async ({ request }) => {
  test.skip(!MANAGES_SERVER, "Only this harness knows how a server it started was configured.");

  const shape = await decision(
    await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id, TINY_DEVICE) })
  );

  if (WEB_MODE === "production") {
    /* Asserted rather than skipped, and it is not a restatement of the test
     * above: this one says the provider gate runs BEFORE eligibility, so the
     * device profile cannot change the answer a hosted deployment gives. A
     * production build that started distinguishing devices here would be one
     * that had resolved candidates. */
    expect(shape.outcome).toBe("unavailable");
    expect(reasonCodes(shape)).toContain("provider_not_configured");
    return;
  }

  /*
   * `granted`, from a device that could decode almost nothing. That reads wrong
   * until you say what the alternative claims: refusing here would mean the
   * platform had decided a stream is too tall for this device on the strength
   * of a height nobody ever measured. PL-0205 calls that the mirror image of an
   * adapter defaulting to `h264` -- both directions invent a fact -- and the
   * engine's answer is to admit the candidate as ATTEMPTABLE and label the
   * session unverified, which is the true statement.
   */
  expect(shape.outcome).toBe("granted");
  expect(reasonCodes(shape)[0]).toBe("session_issued_unverified_compatibility");

  /* The regression guard. A fixture that starts stating `height: 720` again
   * makes this code appear against a 144-pixel ceiling, and the trail is where
   * it would show up first. */
  expect(reasonCodes(shape)).not.toContain("resolution_exceeds_capability");

  const session = isRecord(shape.session) ? shape.session : {};
  const candidates = (Array.isArray(session["candidates"]) ? session["candidates"] : []).filter(
    isRecord
  );

  /* Guards the assertion below against passing on an empty list. `decision()`
   * has already refused a granted session with no candidates, so this is a
   * second line of defence rather than the first -- and it is cheap. */
  expect(candidates.length).toBeGreaterThan(0);

  /*
   * Every candidate, not just the head. `compatibility` is per-candidate
   * because failover reads it per candidate, and a list where the first entry
   * is honest and the rest are not is the shape a partial regression takes.
   */
  const overclaimed = candidates
    .filter((candidate) => candidate["compatibility"] !== "unverified")
    .map((candidate) => `${String(candidate["id"])} claims ${String(candidate["compatibility"])}`);
  expect(overclaimed, "a fixture cannot have verified what nobody opened").toEqual([]);
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
