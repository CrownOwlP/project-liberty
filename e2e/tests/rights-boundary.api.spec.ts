import { expect, test } from "@playwright/test";
import {
  collectStrings,
  isRecord,
  playbackSessionViolations,
  reasonCodes,
  type PlaybackSessionResponseShape
} from "../src/contract";
import { MANAGES_SERVER, WEB_MODE } from "../src/env";
import { CAPABLE_DEVICE, DEMO, SMUGGLED_URI, resolveCandidate } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * The rights boundary, asserted from outside the process
 *
 * These are the tests whose failure would be an incident rather than a bug.
 * Every one of them asks the same question from a different direction: can a
 * client get this platform to play, name, follow or echo a stream that nobody
 * established a right to serve?
 *
 * They are E2E rather than unit tests on purpose. `contract.ts` enforces
 * `.strict()` and `issue-session.ts` orders rights before identity, and both
 * are unit-tested; what is NOT unit-tested is whether those survive the trip
 * through a framework that is entitled to coerce, strip and re-serialise
 * anything it likes on the way in and out.
 * ---------------------------------------------------------------------- */

const SESSION = "/api/v1/playback/session";
const RESOLVE = "/api/v1/playback/resolve";

/**
 * Which build this run measured, recorded on every result in this file.
 *
 * ADDED LATE, AND THE OMISSION WAS THE DEFECT. The other mode-split files have
 * carried this since they gained their splits, and `docs/E2E.md` named five of
 * them. This file is the sixth: the resolve tests below assert a 404 gate under
 * `production` and the engine's rights refusal under `development`, so a result
 * from here is exactly as half-a-statement as one from those five, and until this
 * hook existed the HTML and GitHub reports did not say which half. That matters
 * more here than anywhere: the three scaffold tests SKIP under the default mode,
 * and a skipped rights test in a report that does not name the build reads as
 * coverage.
 */
test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
});

test("the session endpoint refuses a request that names a media URL", async ({ request }) => {
  const response = await request.post(SESSION, {
    data: { contentId: DEMO.movie.id, capabilities: CAPABLE_DEVICE, uri: SMUGGLED_URI }
  });

  const body: unknown = await response.json();
  expect(playbackSessionViolations(body)).toEqual([]);
  const shape = body as PlaybackSessionResponseShape;

  /*
   * REFUSED, not stripped. Zod's default is to drop unknown keys, and a
   * stripped field would produce a perfectly successful session with no
   * indication that the field the client believed in was discarded -- and the
   * next person to add a field to that schema would be one keystroke from
   * honouring it. `.strict()` makes the boundary observable from OUTSIDE the
   * process, which is the only place a client can see it, and this is the test
   * that checks it is observable from there.
   */
  expect(shape.outcome).toBe("denied");
  expect(response.status()).toBe(400);

  /*
   * And it is the PRIMARY reason. An unaccepted field gets its own code rather
   * than being folded into `request_malformed` because it is a rights event:
   * it is a client trying to hand the endpoint the one field it would most
   * like to hand it. Buried at position 3 in a trail nobody reads past the
   * first line of, it would not be visible in the metrics a rights review
   * reads.
   */
  expect(reasonCodes(shape)[0]).toBe("request_field_not_permitted");
  expect(shape.reasons[0]?.detail).toContain("uri");
  expect(shape.session).toBeUndefined();
});

test("a media URL smuggled into the nested capabilities object is refused too", async ({
  request
}) => {
  const response = await request.post(SESSION, {
    data: {
      contentId: DEMO.movie.id,
      capabilities: { ...CAPABLE_DEVICE, manifestUrl: SMUGGLED_URI }
    }
  });

  const shape = (await response.json()) as PlaybackSessionResponseShape;
  expect(playbackSessionViolations(shape)).toEqual([]);
  /* The outer object being strict proves nothing about the inner one, and the
   * inner one is where a field would be least likely to be noticed in review. */
  expect(shape.outcome).toBe("denied");
  expect(reasonCodes(shape)[0]).toBe("request_field_not_permitted");
});

test("no session route echoes a client-supplied address back", async ({ request }) => {
  const bodies = [
    { contentId: DEMO.movie.id, capabilities: CAPABLE_DEVICE, uri: SMUGGLED_URI },
    { contentId: SMUGGLED_URI, capabilities: CAPABLE_DEVICE },
    { contentId: DEMO.movie.id, capabilities: { ...CAPABLE_DEVICE, src: SMUGGLED_URI } }
  ];

  for (const data of bodies) {
    const response = await request.post(SESSION, { data });
    const raw = await response.text();

    /*
     * Reflection is its own vulnerability class even when the value is
     * refused: an error message that quotes an attacker's URL is a URL sitting
     * in our logs, our dashboards and anywhere a support engineer pastes a
     * response. The reason vocabulary is codes precisely so a refusal can be
     * explained without repeating what was refused.
     */
    expect(raw, `echoed the submitted address for ${JSON.stringify(data)}`).not.toContain(
      "smuggled.test"
    );
  }
});

/* -------------------------------------------------------------------------
 * The resolve scaffold, which a production build does not have
 *
 * `/api/v1/playback/resolve` is the only route that accepts candidates at all,
 * so it is the one place a client can put a rights basis in front of the engine
 * -- and it did so unauthenticated. A security review closed that by making it
 * answer 404 / `route_not_available` when `NODE_ENV` is `production`, which is
 * the build this harness runs by DEFAULT.
 *
 * So the tests below split on the mode rather than skipping wholesale. The gate
 * is now itself a rights control: an ungated scaffold reachable from a hosted
 * deployment is the finding, and a suite that only skipped under the default
 * mode would report nothing at all about the build that actually ships.
 *
 * Against an external deployment there is no split to make -- this harness was
 * not told which build is behind that URL, and both answers are correct there.
 * ---------------------------------------------------------------------- */

const UNKNOWN_BUILD_SKIP_REASON =
  "Testing an external deployment whose build mode this harness was not told, so neither " +
  "the 404 gate nor the ranking behaviour is the right expectation. Point the harness at a " +
  "server it starts to assert either.";

const SCAFFOLD_GATED_SKIP_REASON =
  "This server runs a production build, where /api/v1/playback/resolve is not part of the " +
  "deployment and answers 404 by design; the gate test asserts that instead. Set " +
  "LIBERTY_E2E_WEB_MODE=development to exercise the engine's rights refusal end to end.";

/**
 * Guards a test that needs the scaffold to be answering, and says why when it
 * is not. A vacuous pass against a 404 body would be worse than a skip: every
 * assertion below is a "nothing bad came back" assertion, and an absent route
 * satisfies all of them while proving none of them.
 */
function requiresResolveScaffold(): void {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);
  test.skip(WEB_MODE === "production", SCAFFOLD_GATED_SKIP_REASON);
}

test("a production build does not carry the resolve scaffold at all", async ({ request }) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);
  test.skip(
    WEB_MODE !== "production",
    "This server runs a development build, where the scaffold is reachable on purpose."
  );

  const response = await request.post(RESOLVE, {
    data: {
      contentId: DEMO.movie.id,
      capabilities: CAPABLE_DEVICE,
      candidates: [resolveCandidate({ rights: "public-domain" })]
    }
  });

  /*
   * The request that WOULD have succeeded -- a well-formed body with a rightsed
   * candidate. Sending a malformed one would leave the gate indistinguishable
   * from validation, and it is the gate that has to hold.
   *
   * 404 rather than 403 because in a hosted deployment this is not a resource
   * the caller lacks permission for, it is a resource that is not there; a 403
   * would confirm to an unauthenticated caller that it exists somewhere.
   */
  expect(response.status()).toBe(404);
  const body: unknown = await response.json();
  expect(isRecord(body) && body["error"]).toBe("route_not_available");

  /* The load-bearing half. A gate that changed the status line while still
   * ranking would have removed nothing: the verdict is what the review took
   * away, because a verdict is what a caller asserting its own rights was
   * after. */
  expect(isRecord(body) && "selected" in body).toBe(false);
  expect(isRecord(body) && "ranked" in body).toBe(false);
});

test("an unrightsed candidate never yields a selection", async ({ request }) => {
  requiresResolveScaffold();

  /*
   * With the scaffold reachable, this is still the one place worth checking
   * that the engine refuses a rights basis a client chose for itself.
   *
   * `unlicensed` is not a member of the rights vocabulary -- the allowlist is
   * an allowlist, so anything not on it is refused by shape before any scoring
   * happens, and that ordering is the invariant. A future value added to the
   * enum without being added to the playable list must fail the same way.
   */
  for (const rights of ["unlicensed", "pirated", "unknown", null, ""]) {
    const response = await request.post(RESOLVE, {
      data: {
        contentId: DEMO.movie.id,
        capabilities: CAPABLE_DEVICE,
        candidates: [resolveCandidate({ rights })]
      }
    });

    const body: unknown = await response.json();
    const label = `rights ${JSON.stringify(rights)}`;

    expect(response.status(), label).toBe(400);
    expect(isRecord(body) && body["error"], label).toBe("invalid_request");
    /* The load-bearing half: not merely "an error", but no selection anywhere
     * in the response. A 400 that still carried a ranked candidate would be a
     * refusal a caller could ignore. */
    expect(isRecord(body) && "selected" in body, label).toBe(false);
    expect(isRecord(body) && "ranked" in body, label).toBe(false);
  }
});

test("a rightsed candidate resolves, so the refusal above is about rights", async ({ request }) => {
  requiresResolveScaffold();

  /*
   * The control. Without it, every assertion in the test above would still
   * pass if the endpoint had simply stopped working, and a rights gate that is
   * indistinguishable from an outage is not evidence of anything. That is also
   * why it is guarded rather than left to fail: under a production build the
   * endpoint HAS stopped working, deliberately, and this test failing would
   * report a rights regression that did not happen.
   */
  const response = await request.post(RESOLVE, {
    data: {
      contentId: DEMO.movie.id,
      capabilities: CAPABLE_DEVICE,
      candidates: [resolveCandidate({ rights: "public-domain" })]
    }
  });

  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(isRecord(body) && body["selected"]).toBeTruthy();
});

test("the resolve route never accepts, acts on or returns a candidate URL", async ({ request }) => {
  requiresResolveScaffold();

  const response = await request.post(RESOLVE, {
    data: {
      contentId: DEMO.movie.id,
      capabilities: CAPABLE_DEVICE,
      candidates: [resolveCandidate({ uri: SMUGGLED_URI, source: { uri: SMUGGLED_URI } })]
    }
  });

  const body: unknown = await response.json();

  /*
   * A candidate is METADATA -- rights, protocol, height, codecs, health. There
   * is no `uri` in the candidate contract and there must never be one, because
   * that is the field that would turn a ranking endpoint into a chooser of
   * arbitrary media. Whether the framework refuses the extra key or drops it,
   * the property that matters is the same and is checked here: nothing the
   * client named comes back out, and nothing downstream could have read it.
   */
  const strings = collectStrings(body);
  expect(strings.filter((value) => value.includes("smuggled.test"))).toEqual([]);
  expect(strings.filter((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value))).toEqual([]);
});
