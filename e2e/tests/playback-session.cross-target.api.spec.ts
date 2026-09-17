import { expect, request as playwrightRequest, test } from "@playwright/test";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import {
  expectedStatus,
  isRecord,
  playbackSessionViolations,
  reasonCodes,
  type PlaybackSessionResponseShape
} from "../src/contract";
import { DESKTOP_BASE_URL, DESKTOP_SKIP_REASON, WEB_MODE } from "../src/env";
import { CAPABLE_DEVICE, DEMO, TINY_DEVICE, sessionRequest } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * CROSS-TARGET CONTRACT EQUIVALENCE (PL-0501, round 45, correction 4)
 *
 * WRITTEN BY PL-0501 INSIDE PL-0701's DECLARED SURFACE -- see
 * `playback-session.desktop.api.spec.ts` for the provenance note.
 *
 * `docs/DESKTOP_PLAYBACK.md` §8: "Same route path. Same URL. Same request
 * shape, same response shape, same status codes, same error bodies, same
 * reason-trail semantics [...] The desktop implementation differs behind the
 * boundary and NOWHERE IN FRONT OF IT, so nothing in `apps/web` client code can
 * tell which build it is running in."
 *
 * Round 44's gate called this "the check that would actually catch a divergence
 * nobody thought of, and it is the one the implementer most wanted and could
 * not write". This is it: one request table, both targets, diffed.
 *
 * WHAT MAKES THE COMPARISON HONEST RATHER THAN CIRCULAR. The desktop target
 * does not resolve, so its answer has to come from somewhere; if the stub
 * backend invented its own decisions, this suite would be comparing the real
 * route against a reimplementation of it and every difference would be the
 * stub's fault. So the stub RELAYS to the web-target server for every content
 * id except the handful it reserves. Both targets therefore answer from ONE
 * decision, taken once, by the real resolving implementation -- and any
 * difference that shows up here is a difference in the ENVELOPE, which is
 * exactly what §8 says must be identical and exactly what the two targets
 * genuinely compile separately.
 *
 * WHAT IS EXCLUDED FROM THE DIFF, AND WHY EACH ONE IS NOT A LOOPHOLE.
 *
 *   - `sessionId`: required to be unguessable, so two calls must differ. The
 *     web spec already strips it for the same reason.
 *   - `expiresAt`: a clock reading, taken in two processes microseconds apart.
 *
 * Nothing else is excluded. In particular the candidate list, the URIs, the
 * per-candidate `compatibility` and `protection`, the whole reason trail in
 * order, the outcome and the HTTP status are all compared verbatim.
 * ---------------------------------------------------------------------- */

const ROUTE = "/api/v1/playback/session";

test.skip(DESKTOP_SKIP_REASON !== null, DESKTOP_SKIP_REASON ?? "");

test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
  test.info().annotations.push({ type: "build-target", description: "web+desktop" });
});

let desktop: APIRequestContext;

test.beforeAll(async () => {
  desktop = await playwrightRequest.newContext({ baseURL: DESKTOP_BASE_URL });
});

test.afterAll(async () => {
  await desktop.dispose();
});

/**
 * The request table. ONE TABLE, DRIVEN AGAINST BOTH TARGETS.
 *
 * Every row is a case the web spec already exercises against the web target
 * alone, plus the shapes whose handling differs most between an implementation
 * that parses a body and one that relays it. A row that the two targets
 * legitimately answer differently would have to be excluded here with a stated
 * reason; there is not one, and that is the point.
 */
const REQUESTS: readonly { readonly name: string; readonly body: unknown }[] = [
  { name: "a well-formed request", body: sessionRequest(DEMO.movie.id) },
  { name: "a second content id", body: sessionRequest(DEMO.series.id) },
  { name: "a device that can decode almost nothing", body: sessionRequest(DEMO.movie.id, TINY_DEVICE) },
  { name: "a capable device", body: sessionRequest(DEMO.movie.id, CAPABLE_DEVICE) },
  { name: "no capabilities at all", body: { contentId: DEMO.movie.id } },
  {
    name: "a field the schema does not permit",
    body: { ...sessionRequest(DEMO.movie.id), uri: "https://smuggled.test/x.mpd" }
  },
  { name: "a path-traversal content id", body: sessionRequest("../../etc/passwd") },
  { name: "an un-normalized content id", body: sessionRequest("Aurora Fall") },
  { name: "an absolute URL as a content id", body: sessionRequest("https://evil.test/x.mpd") },
  { name: "an empty content id", body: sessionRequest("") },
  { name: "an empty object", body: {} },
  { name: "a JSON array", body: [] },
  { name: "a bare number", body: 7 },
  { name: "JSON null", body: null }
];

interface Observation {
  readonly status: number;
  readonly cacheControl: string;
  readonly shape: PlaybackSessionResponseShape;
}

async function observe(response: APIResponse): Promise<Observation> {
  const body: unknown = await response.json();
  expect(playbackSessionViolations(body), `response body: ${JSON.stringify(body)}`).toEqual([]);
  const shape = body as PlaybackSessionResponseShape;
  expect(response.status()).toBe(expectedStatus(shape));
  return {
    status: response.status(),
    cacheControl: response.headers()["cache-control"] ?? "",
    shape
  };
}

/** The body with the two per-call fields removed, and nothing else. */
function comparable(shape: PlaybackSessionResponseShape): unknown {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(shape));
  const session = clone["session"];
  if (isRecord(session)) {
    delete session["sessionId"];
    delete session["expiresAt"];
  }
  return clone;
}

for (const row of REQUESTS) {
  test(`both targets answer identically: ${row.name}`, async ({ request }) => {
    const web = await observe(await request.post(ROUTE, { data: row.body }));
    const desk = await observe(await desktop.post(ROUTE, { data: row.body }));

    /* STATUS. §8 lists "same status codes" and this is the one a client branches
     * on before it reads anything. */
    expect(desk.status, `status differs for ${row.name}`).toBe(web.status);

    /* OUTCOME and the REASON SEMANTICS behind it, compared as the ordered code
     * list rather than as a set: `reasons[0]` is the PRIMARY reason, the one
     * that decided the outcome and the one `playbackSessionHttpStatus` reads,
     * so an order difference is a semantic difference. */
    expect(desk.shape.outcome, `outcome differs for ${row.name}`).toBe(web.shape.outcome);
    expect(reasonCodes(desk.shape), `reason codes differ for ${row.name}`).toEqual(
      reasonCodes(web.shape)
    );

    /* `no-store` AT EVERY LAYER, on both targets. A desktop build that lost it
     * would be a per-viewer session sitting in a cache on a shared machine. */
    expect(desk.cacheControl).toContain("no-store");
    expect(web.cacheControl).toContain("no-store");

    /* THE WHOLE BODY. The three assertions above name the properties that
     * matter most; this one catches the divergence nobody thought of, which is
     * the reason the reviewer asked for this file. */
    expect(comparable(desk.shape), `body differs for ${row.name}`).toEqual(
      comparable(web.shape)
    );
  });
}

test("the equivalence table is not vacuously passing on refusals alone", async ({ request }) => {
  /*
   * THE PAIRING FOR THE WHOLE FILE. Twelve of the rows above are refusals, and
   * two identical refusals would be produced by two targets that had both
   * simply broken. Under `development` the table's first rows must be GRANTS
   * with a real candidate list on both sides, and that is what makes the
   * comparison meaningful rather than a pair of matching 400s.
   *
   * Under `production` the honest counterpart is weaker and is asserted as
   * such: a production build resolves nothing on purpose, so what is paired
   * there is that both targets reach the provider gate and name the same
   * operator remedy -- which is still a statement about the envelope, and it is
   * the strongest one that build can support.
   */
  const web = await observe(await request.post(ROUTE, { data: sessionRequest(DEMO.movie.id) }));
  const desk = await observe(await desktop.post(ROUTE, { data: sessionRequest(DEMO.movie.id) }));

  if (WEB_MODE === "development") {
    expect(web.shape.outcome).toBe("granted");
    expect(desk.shape.outcome).toBe("granted");

    const candidates = (shape: PlaybackSessionResponseShape) =>
      (isRecord(shape.session) && Array.isArray(shape.session["candidates"])
        ? shape.session["candidates"]
        : []
      ).filter(isRecord);

    expect(candidates(web.shape).length).toBeGreaterThan(0);
    /* THE CANDIDATE LIST CROSSED THE WIRE INTACT: same ids, same order, same
     * URIs, same per-candidate protection. This is the payload a player acts
     * on, and it is the one thing a forwarder could plausibly mangle. */
    expect(candidates(desk.shape)).toEqual(candidates(web.shape));
  } else {
    expect(web.shape.outcome).toBe("unavailable");
    expect(desk.shape.outcome).toBe("unavailable");
    expect(reasonCodes(web.shape)).toContain("provider_not_configured");
    expect(reasonCodes(desk.shape)).toContain("provider_not_configured");
  }
});

test("neither target answers a GET with a session", async ({ request }) => {
  for (const [label, response] of [
    ["web", await request.get(ROUTE)],
    ["desktop", await desktop.get(ROUTE)]
  ] as const) {
    expect(response.status(), `${label} answered a GET with 200`).not.toBe(200);
  }
});
