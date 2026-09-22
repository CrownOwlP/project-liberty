import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { APIResponse } from "@playwright/test";
import {
  collectStrings,
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

/**
 * Which build this run measured, recorded on every result in this file.
 *
 * THE MODE IS PART OF THE EVIDENCE, not a detail of how the suite was invoked.
 * This file asserts one thing under `production` and a different thing under
 * `development`, so "playback-session.api.spec.ts passed" is only half a
 * statement -- and the half that gets recorded as a gate result is whichever
 * mode somebody happened to run. Annotating it puts the answer in the HTML and
 * GitHub reporters beside each test, so a result that covers one mode says so
 * on its face. `docs/E2E.md` states that both runs are the gate.
 */
test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
});

/**
 * Strings that only the fixture provider can put into a response.
 *
 * The three file names and the three candidate ids are composed by
 * `authorized-candidates.ts`; `fixtures.invalid` is the origin the harness pins
 * when no rig is configured. None of them can appear in a response that resolved
 * nothing.
 *
 * `operator-owned-master` USED TO BE IN THIS LIST AND HAS BEEN REMOVED, because
 * it was an assertion that could not fail in either mode. It is the `basis` half
 * of the `RightsBasis` the fixture candidates carry, and the session response
 * does not publish a basis: `playbackSessionCandidateSchema` in the route's
 * `contract.ts` declares exactly `id`, `providerId`, `uri`, `mimeType` and
 * `compatibility`, and no reason in `issue-session.ts` renders one either -- the
 * rights trail prints `candidate.rights` (the word `owned`), never the basis. So
 * the string could never appear under `production`, which made the absence check
 * free, and it could never appear under `development` either, which made it
 * unpairable. A check that cannot fail reads like coverage and is not.
 *
 * If the response shape ever starts publishing a rights basis, add it back here;
 * the development half below is derived from this list, so it is paired by
 * construction.
 *
 * Checked as a SET OF STRINGS ANYWHERE IN THE BODY rather than by reading named
 * fields, for the reason `collectStrings` exists: a leak in a field somebody
 * already thought of is the one that was going to be found anyway.
 */
const FIXTURE_ARTEFACTS: readonly string[] = [
  "720p.mp4",
  "master.m3u8",
  "manifest.mpd",
  "fixtures.invalid",
  `${DEMO.movie.id}-progressive`,
  `${DEMO.movie.id}-hls`,
  `${DEMO.movie.id}-dash`
];

/**
 * THE ONE ARTEFACT ABOVE WITH NO DEVELOPMENT COUNTERPART, named here rather than
 * left to be discovered by counting the two loops.
 *
 * `fixtures.invalid` is only the DEFAULT origin -- the RFC 2606 host this harness
 * pins as `LIBERTY_FIXTURE_MEDIA_ORIGIN` on a server it starts when no rig is
 * configured (`SERVER_MEDIA_ORIGIN` in `../src/env`), and the app's own fallback
 * besides. A run with `LIBERTY_E2E_MEDIA_ORIGIN` set legitimately produces a
 * different origin, so requiring it to be PRESENT under `development` would fail
 * exactly when a rig is in play. Its production half is therefore an UNPAIRED
 * absence: still worth asserting, because the default origin reaching a shipped
 * build is a real leak, but not proven non-vacuous by the development branch.
 */
const UNPAIRED_ARTEFACT = "fixtures.invalid";

/**
 * The artefacts whose absence under `production` is matched by a presence
 * assertion under `development`.
 *
 * DERIVED rather than written out a second time. A hand-maintained second list is
 * how the two halves came to differ in the first place: the production loop
 * required eight strings and the development loop offered three, while the file
 * and `docs/E2E.md` both described them as the same list.
 */
const PAIRED_ARTEFACTS: readonly string[] = FIXTURE_ARTEFACTS.filter(
  (artefact) => artefact !== UNPAIRED_ARTEFACT
);

/** Every artefact above that appears anywhere in the body's strings. */
function fixtureArtefactsIn(shape: PlaybackSessionResponseShape): string[] {
  const strings = collectStrings(shape).join("\n");
  return FIXTURE_ARTEFACTS.filter((artefact) => strings.includes(artefact));
}

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

    /*
     * REFUSED RATHER THAN FABRICATED, asserted as the absence of the fabrication
     * and not only as the presence of the refusal. `decision()` has already
     * required that a non-granted response carries no `session` key at all --
     * `playbackSessionViolations` treats a refusal shipping a session as a
     * violation -- so what is left to check is the leak that would not be a
     * session: a fixture URI or a fixture candidate id surfacing in a reason's
     * `detail`, in a build where the provider was never constructible.
     */
    expect(
      fixtureArtefactsIn(shape),
      "a production build published something only the fixture provider can produce"
    ).toEqual([]);
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

    /*
     * THE OTHER HALF OF THE PAIR, and what stops the production assertion above
     * from being vacuous. Under a development build the fixture provider IS
     * constructible, so its candidate ids and its composed URIs are both in the
     * granted session; if they ever stopped appearing here, the production check
     * would go on passing and would have stopped proving anything.
     *
     * THE FILE NAMES ARE PAIRED TOO, and that is not an accident of the default
     * origin. `fixtureUri` composes `<origin>/<contentId>/<file>` through `URL`,
     * so a configured rig changes the ORIGIN and never the three file names; and
     * all three candidates are built from the SAME origin, so `checkUrl` admits
     * all three or none of them. A `granted` outcome therefore carries all three
     * URIs, with or without `LIBERTY_E2E_MEDIA_ORIGIN`.
     *
     * `fixtures.invalid` is the single deliberate exception -- see
     * `UNPAIRED_ARTEFACT` for why a rig may legitimately replace it.
     */
    const strings = collectStrings(shape).join("\n");
    for (const artefact of PAIRED_ARTEFACTS) {
      expect(strings, "a development build resolved no fixture candidates").toContain(artefact);
    }
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

  /*
   * `null` means "engine default" -- the beginning for VOD, the live edge for
   * live -- and it is a different claim from `0`.
   *
   * THE SENTENCE THIS REPLACES SAID RESUME-FROM-PROGRESS "DOES NOT EXIST YET",
   * AND HALF OF THAT HAS STOPPED BEING TRUE. PL-0403's HTTP surface has landed
   * and `progress.api.spec.ts` asserts it end to end: a resume point can be
   * leased, written and read back. What has NOT landed is the join. This route
   * never asks for one -- `issue-session.ts` writes `startAtSeconds: null`
   * unconditionally, with no repository, no profile scope and nothing to read a
   * position from -- so `null` is still the honest answer here rather than a
   * placeholder.
   *
   * That makes this assertion sharper than it was, not staler: it now says the
   * session issuer states no resume point RATHER THAN a wrong one, on a build
   * where a stored position genuinely exists a request away. The thing that must
   * change it deliberately is the issuer starting to read progress, which is a
   * different event from PL-0403 landing.
   */
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

/* -------------------------------------------------------------------------
 * The 16 KiB envelope cap (PL-0707, carried by PL-0701)
 *
 * `handler.ts` meters the request body BEFORE the decision and refuses an
 * oversized one with `request_body_too_large` / 413. Two things are asserted
 * here and they are not the same thing:
 *
 *   - the STATUS, because 413 is the whole point of the code. A size refusal
 *     that arrived as 400 would be indistinguishable on the wire from a typo'd
 *     field, and the operator remedies differ;
 *   - the CODE, because a 413 with some other reason in the trail would mean
 *     the route refused the body for a reason it has not named.
 *
 * `decision()` already cross-checks the status against `expectedStatus` from
 * `../src/contract`, which is an INDEPENDENT restatement of the server's
 * mapping -- see that file's header. So this pair of tests is also what makes
 * the restatement non-vacuous: before the 413 branch existed there, an
 * oversized request would have failed `decision()` on the status cross-check.
 * ---------------------------------------------------------------------- */

/** The cap `handler.ts` applies, restated here for the same reason the status is. */
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/**
 * A request that is OVER the cap while being otherwise WELL FORMED.
 *
 * Padded through `preferredAudioLanguages`, which the capabilities schema
 * declares as an unbounded `z.array(z.string())`, rather than by adding a junk
 * key or a giant `contentId`. Both of those would be refused by the schema as
 * `request_field_not_permitted` or `request_malformed` whatever their size, and
 * the test would then pass without the cap existing at all. This body has
 * nothing wrong with it except its length, so a 413 can only have come from the
 * envelope gate.
 */
function paddedSessionRequest(targetBytes: number) {
  const languages: string[] = [];
  let body = "";
  for (;;) {
    const candidate = {
      contentId: DEMO.movie.id,
      capabilities: { ...CAPABLE_DEVICE, preferredAudioLanguages: ["en", ...languages] }
    };
    body = JSON.stringify(candidate);
    if (Buffer.byteLength(body, "utf8") >= targetBytes) return { payload: candidate, body };
    /* 64 tags at a time: the loop is a size search, not a byte-exact
     * construction, and stepping one at a time over 16 KiB is 2,000 JSON
     * serializations for no gain. */
    for (let index = 0; index < 64; index += 1) languages.push(`x-pad-${languages.length}`);
  }
}

test("an oversized body is refused unread, with 413 and a size reason", async ({ request }) => {
  const oversized = paddedSessionRequest(MAX_REQUEST_BODY_BYTES + 1);
  expect(
    Buffer.byteLength(oversized.body, "utf8"),
    "the fixture did not actually exceed the cap"
  ).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);

  const response = await request.post(ROUTE, {
    headers: { "content-type": "application/json" },
    data: oversized.body
  });

  /* Not a 500 and not a hang: a cap that crashes the route is a denial of
   * service with extra steps. */
  const shape = await decision(response);
  expect(response.status()).toBe(413);
  expect(shape.outcome).toBe("denied");
  expect(reasonCodes(shape)).toContain("request_body_too_large");

  /*
   * REFUSED BEFORE THE DECISION, asserted rather than assumed. A refusal that
   * had run the resolver first would have the resolver's codes in the trail
   * too, and the memory the cap exists to protect would already have been
   * spent. The size code is the PRIMARY reason, which is also what the status
   * mapping reads.
   */
  expect(reasonCodes(shape)[0]).toBe("request_body_too_large");

  /* Nothing the client sent comes back. A refusal that echoed 16 KiB of
   * attacker-chosen strings is an amplifier. */
  const echoed = collectStrings(shape).filter((value) => value.includes("x-pad-"));
  expect(echoed, "the refusal echoed the padding it refused").toEqual([]);
});

test("a body just under the cap is not refused for its size", async ({ request }) => {
  /*
   * THE OTHER HALF OF THE PAIR, and what stops the test above from passing
   * against a route that refuses everything. 1 KiB of headroom rather than
   * exactly one byte: the cap is metered against the bytes on the socket, and
   * this spec cannot control whether the client re-serializes with different
   * whitespace. What is being proven is that a large-but-legal body is decided
   * on its merits, not that the boundary is at one exact byte -- the unit
   * suite owns the boundary.
   */
  const under = paddedSessionRequest(MAX_REQUEST_BODY_BYTES - 2048);
  expect(Buffer.byteLength(under.body, "utf8")).toBeLessThan(MAX_REQUEST_BODY_BYTES);

  const shape = await decision(
    await request.post(ROUTE, {
      headers: { "content-type": "application/json" },
      data: under.body
    })
  );

  /* Deliberately NOT an assertion about the outcome: what this deployment
   * resolves is the subject of the tests above and differs by build mode. The
   * subject here is only that the envelope gate did not fire. */
  expect(reasonCodes(shape)).not.toContain("request_body_too_large");
});

test("the status mapping this suite checks against is not the server's own", async () => {
  /*
   * THE ASSERTION THAT KEEPS THE 413 ABOVE MEANINGFUL.
   *
   * `decision()` proves the wire status matches `expectedStatus`, which is only
   * evidence while `expectedStatus` is written independently. The single edit
   * that would silently destroy that -- and which looks like a tidy-up in a
   * diff -- is importing the server's `playbackSessionHttpStatus` so the two
   * "cannot disagree". They are supposed to be able to disagree.
   *
   * CHECKED AGAINST THE IMPORT STATEMENTS, NOT THE WHOLE FILE. A substring
   * search over the source was the first spelling of this test and it failed on
   * its own subject: `src/contract.ts`'s header NAMES the function it refuses to
   * import, which is exactly the documentation this guard exists to keep
   * truthful. A guard that forbids writing down what you are not doing teaches
   * the next person to delete the explanation.
   */
  const source = await readFile(path.resolve(__dirname, "../src/contract.ts"), "utf8");

  /* Every `import ... from "x"` and `require("x")`, module specifier captured. */
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s+["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g),
    ...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)
  ].map((match) => match[1]);

  /*
   * NOTHING FROM THE APPLICATION, and nothing at all as it happens: the file is
   * meant to be a standalone restatement. Listed as the specifiers found rather
   * than as a boolean so a failure names what crept in.
   */
  expect(
    specifiers.filter(
      (specifier) =>
        specifier !== undefined &&
        (specifier.startsWith("@liberty") ||
          specifier.includes("apps/web") ||
          specifier.includes("/session/contract"))
    ),
    "the e2e contract now imports the application it is supposed to measure"
  ).toEqual([]);

  /* The function itself is never CALLED here, however it might be reached. */
  expect(source).not.toMatch(/playbackSessionHttpStatus\s*\(/);

  /* And the restatement is actually present, so this guard cannot pass against
   * a file that simply deleted the branch it is guarding. */
  expect(source).toContain("request_body_too_large");
  expect(source).toContain("413");
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
