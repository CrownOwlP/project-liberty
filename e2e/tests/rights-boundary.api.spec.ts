import { expect, test } from "@playwright/test";
import {
  collectStrings,
  isRecord,
  playbackSessionViolations,
  reasonCodes,
  type PlaybackSessionResponseShape
} from "../src/contract";
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

test("an unrightsed candidate never yields a selection", async ({ request }) => {
  /*
   * `/api/v1/playback/resolve` is the only route that accepts candidates at
   * all, and its own contract documents it as a testing-only scaffold. That
   * makes it the one place a client can put a rights basis in front of the
   * engine, so it is the one place worth checking that the engine refuses one.
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
  /*
   * The control. Without it, every assertion in the test above would still
   * pass if the endpoint had simply stopped working, and a rights gate that is
   * indistinguishable from an outage is not evidence of anything.
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
