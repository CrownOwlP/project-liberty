import { expect, test } from "@playwright/test";
import { collectKeys, collectStrings, isRecord } from "../src/contract";
import { CATALOG_AVAILABILITY, UNKNOWN_CATALOG_SKIP_REASON, WEB_MODE } from "../src/env";
import { CATALOG_ARTEFACTS } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * The catalog surface, at the wire
 *
 * The assertions worth having here are not "the rails rendered". They are the
 * two claims the catalog makes that a regression could quietly withdraw: that
 * nothing reaches a reader without a rights basis on the allowlist, and that a
 * catalog response is metadata and never an address.
 *
 * THE CATALOG IS GATED, AND THIS FILE USED TO FAIL IN THE HARNESS'S DEFAULT MODE
 * BECAUSE OF IT. `lib/catalog-source-registry.ts` resolves the demo catalog only
 * for a `NonDeploymentEnvironment` -- the same nominal witness the playback
 * fixtures need, and for a related reason: the `owned` category on those six
 * works is true, but the claim a deployment would be making by serving them is
 * "this is the catalog", and serving invented titles from a hosted build states
 * them to a reader as the product's content. So a production build has no
 * metadata source at all, and "the home catalog is non-empty" stopped being a
 * property of every build the moment that landed.
 *
 * THE ROUTE NOW REFUSES RATHER THAN SERVING EMPTY RAILS, and this file used to
 * assert the opposite. `route.ts` awaits `loadHomeCatalog()` and hands the
 * result to `./handler.ts`; it no longer calls the synchronous `getHomeCatalog`,
 * whose return type is a `CatalogHomeResponse` with nowhere to put a reason. A
 * build with no metadata source therefore answers `503` with
 * `{ "error": "catalog_source_not_configured" }` instead of `{ rails: [] }` at
 * 200, which `docs/API_CONTRACTS.md` reserves for a configured catalog that
 * genuinely surfaces nothing. The comment block that described the 200 as
 * "today's behaviour, to be updated deliberately when the route migrates" is
 * gone rather than annotated: it described a route that no longer exists.
 *
 * The split below is the one `playback-session.api.spec.ts` already uses rather
 * than a second idiom invented here: assert BOTH branches, on the SAME derived
 * list of strings, so neither half can pass vacuously. An empty catalog satisfies
 * every "no offender" assertion in this file while proving nothing, which is
 * exactly the shape of failure the pairing exists to catch.
 * ---------------------------------------------------------------------- */

/** The one rights vocabulary, from `@liberty/contracts/shared/rights`. */
const PLAYABLE_RIGHTS = ["licensed", "owned", "public-domain"];

/**
 * Key names that would mean a catalog item had started carrying a media
 * address. Matched case-insensitively as whole words against every key in the
 * response, because the failure this catches is a new field somebody added in
 * good faith -- `streamUrl`, `manifest`, `playbackUri` -- not a malicious one.
 */
const ADDRESS_KEY = /^(uri|url|src|href|manifest|stream|playback)(url|uri|src)?$/i;

/**
 * The reason code a build with no catalog metadata source refuses with.
 *
 * Restated here rather than imported, for the reason `e2e/src/fixtures.ts`
 * restates the content ids: this directory is outside the npm workspaces, and a
 * harness that read the server's own constant would follow a rename instead of
 * noticing one.
 *
 * THIS COMMENT USED TO ADD "there is nothing to import in any case", on the
 * grounds that `CatalogLoadResult.reason` is typed `string`. The type is still
 * `string` and the conclusion has stopped following: `app/search/search.ts`
 * exports `CATALOG_SOURCE_NOT_CONFIGURED_REASON` and
 * `app/title/demo-title-details.ts` declares the same literal as the `reason`
 * field of `CatalogMetadataSourceNotConfiguredError`. So the app now spells this
 * value in three places of its own, none of which is a shared constant -- which
 * makes the restatement here worth MORE than it was, not less. A rename that
 * reached two of the three is exactly the drift a harness with its own copy
 * catches.
 */
const CATALOG_SOURCE_NOT_CONFIGURED = "catalog_source_not_configured";

/**
 * The statuses a CORRECT build answers this route with: 200 for a configured
 * source, 503 for one that is absent or unreachable.
 *
 * `handler.ts` can also answer 500, for `catalog_response_failed_validation` --
 * the server could not publish what its own source said. That is deliberately
 * absent from this list rather than omitted by oversight: it is a fault on this
 * side of the boundary, no build under test may reach it, and admitting it here
 * would turn a server-side inconsistency into a pass.
 */
const PUBLISHED_STATUSES: readonly number[] = [200, 503];

/**
 * Which build this run measured, recorded on every result in this file.
 *
 * THE MODE IS PART OF THE EVIDENCE, for the reason the session spec gives: this
 * file now asserts one thing under `production` and a different thing under
 * `development`, so a gate record that does not name the mode is half a
 * statement. `docs/E2E.md` states that both runs together are the gate.
 */
test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
});

/**
 * Every item on every rail.
 *
 * A function rather than the loop it used to be inline, because BOTH assertions
 * below are "this list is empty" assertions and an empty catalog satisfies each
 * of them while proving nothing. It answers `[]` for a refusal body too, which
 * has no `rails` key at all -- that is what the two skips below key on.
 */
function railItems(body: unknown): Record<string, unknown>[] {
  const rails = isRecord(body) && Array.isArray(body["rails"]) ? body["rails"] : [];
  return rails
    .filter(isRecord)
    .flatMap((rail) => (Array.isArray(rail["items"]) ? rail["items"] : []))
    .filter(isRecord);
}

/**
 * Why an item-level invariant cannot be checked on this build.
 *
 * A SKIP RATHER THAN A GUARD THAT PASSES. The two tests below used to assert
 * `items.length > 0` themselves, which was correct while every build had a
 * catalog and became a failure that blamed the wrong thing once one did not.
 * They are about what an item may carry, so with no items they have nothing to
 * say -- and the absence they are skipping on is not taken on trust: "what the
 * home catalog answers is decided by the build" below REQUIRES the refusal under
 * `production` and requires rails full of the demo catalog under `development`.
 */
const NO_ITEMS_SKIP_REASON =
  "This build resolves no catalog metadata source, so this route refused with " +
  "catalog_source_not_configured and published no rail at all -- an item-level invariant has " +
  "nothing to check. That the refusal is what this build answers, and that a development build " +
  "answers rails carrying the demo catalog instead, is asserted by \"what the home catalog " +
  "answers is decided by the build\" in this file, so this skip is not where the absence goes " +
  "unexamined.";

test("health responds before anything else is believed", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("the home catalog is uncacheable and never an empty body, on every build", async ({
  request
}) => {
  const response = await request.get("/api/v1/catalog/home");

  /*
   * MODE-INDEPENDENT ON PURPOSE, and deliberately no longer an assertion that
   * the status is 200. Which status this route answers is now a fact about the
   * build -- see the test below -- so what belongs here is the part that must
   * not move on either: it answers one of its two published statuses, it says
   * so uncacheably, and it says something.
   */
  expect(PUBLISHED_STATUSES).toContain(response.status());

  /* Request-scoped data, and `handler.ts` applies this to the refusal branches
   * as well as to the success one. A shared cache holding a catalog is how a
   * region or an entitlement decision made for one reader is served to another;
   * a cached refusal outlives the configuration that caused it. */
  expect(response.headers()["cache-control"]).toContain("no-store");

  const body: unknown = await response.json();
  expect(isRecord(body)).toBe(true);

  /*
   * `docs/API_CONTRACTS.md`: a failure "is never an empty body". Checked as the
   * key count rather than as a named field because the two branches publish
   * different keys -- `rails`/`generatedAt` on one, `error` on the other -- and
   * the claim being made here is about neither in particular. A route that
   * started answering `{}` would sail past both item-level tests below -- they
   * skip on a response with no rail items, which `{}` is -- so this is the line
   * that would catch it.
   */
  expect(Object.keys(isRecord(body) ? body : {}).length).toBeGreaterThan(0);
});

test("what the home catalog answers is decided by the build, and both are asserted", async ({
  request
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  const response = await request.get("/api/v1/catalog/home");
  const body: unknown = await response.json();
  const strings = collectStrings(body).join("\n");

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * A HOSTED BUILD REFUSES, WITH A REASON, AND THE REASON IS THE ASSERTION.
     * `loadHomeCatalog` reports `catalog_source_not_configured` for a source
     * that has no provider to ask, and `handler.ts` maps it onto 503 -- the same
     * status the profile, progress and watchlist routes answer for
     * `authentication_not_configured`, so an operator reading across this app
     * sees one status for "this deployment is missing a dependency".
     *
     * 503 AND NOT 500, asserted exactly rather than as "some failure". The two
     * are different findings with different owners: 500 means this server could
     * not publish what its own source said, which is a fault on this side of the
     * boundary, and if this route ever answers it here the catalog gate is not
     * what went wrong.
     */
    expect(response.status()).toBe(503);
    expect(isRecord(body) ? body["error"] : null).toBe(CATALOG_SOURCE_NOT_CONFIGURED);

    /*
     * A REFUSAL CARRIES NO CATALOG, which is a separate claim from the code
     * above and fails separately. A route that answered 503 while still shipping
     * a `rails` key would be publishing a catalog under a status that says there
     * is none, and every consumer that branches on the status would discard it.
     */
    expect(
      isRecord(body) ? body["rails"] : undefined,
      "a refusal published a rails key"
    ).toBeUndefined();

    /*
     * THE ABSENCE HALF OF THE PAIR, and it is not a restatement of the lines
     * above. Those say the response is a refusal with the right code; this says
     * that nothing only the demo catalog can produce reached the response by any
     * other path -- a stray genre, a rail title, an id in a diagnostic field the
     * refusal grew later. The development branch requires every one of these same
     * strings to be PRESENT, from the same array iterated whole, which is what
     * keeps this from being a check against a blank page.
     */
    const leaked = CATALOG_ARTEFACTS.filter((artefact) => strings.includes(artefact));
    expect(leaked, "a deployment served something only the demo catalog can produce").toEqual([]);
    return;
  }

  /*
   * The build that has a metadata source. 200 is asserted here rather than in
   * the mode-independent test above, because it is now half of a pair rather
   * than a property of the route.
   */
  expect(response.status()).toBe(200);

  const rails = isRecord(body) && Array.isArray(body["rails"]) ? body["rails"] : [];
  expect(rails.length).toBeGreaterThan(0);
  expect(railItems(body).length).toBeGreaterThan(0);

  /* THE WHOLE ARRAY, iterated rather than restated as a second list. A
   * hand-maintained counterpart is how the session spec's two halves came to
   * differ while the file described them as the same. */
  for (const artefact of CATALOG_ARTEFACTS) {
    expect(strings, "a development build published no demo catalog").toContain(artefact);
  }
});

test("every surfaced item carries a rights basis on the playable allowlist", async ({ request }) => {
  const body: unknown = await (await request.get("/api/v1/catalog/home")).json();
  const items = railItems(body);

  test.skip(items.length === 0, NO_ITEMS_SKIP_REASON);

  const offenders = items
    .filter((item) => {
      const rights = item["rights"];
      return typeof rights !== "string" || !PLAYABLE_RIGHTS.includes(rights);
    })
    .map((item) => `${String(item["id"])} carries rights ${JSON.stringify(item["rights"])}`);

  expect(offenders).toEqual([]);
});

test("the catalog publishes no media address, under any key name", async ({ request }) => {
  const body: unknown = await (await request.get("/api/v1/catalog/home")).json();

  test.skip(railItems(body).length === 0, NO_ITEMS_SKIP_REASON);

  const addressKeys = collectKeys(body).filter((key) => ADDRESS_KEY.test(key));
  expect(addressKeys, "the catalog is metadata; a stream is resolved at playback time").toEqual([]);

  /* Belt and braces on the values, because a media address can also arrive
   * under an innocent key name. The catalog has no legitimate reason to
   * contain an absolute URL of any kind today. */
  const urls = collectStrings(body).filter((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value));
  expect(urls).toEqual([]);
});
