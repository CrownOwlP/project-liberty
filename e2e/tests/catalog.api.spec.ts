import { expect, test } from "@playwright/test";
import { collectKeys, collectStrings, isRecord } from "../src/contract";

/* -------------------------------------------------------------------------
 * The catalog surface, at the wire
 *
 * The assertions worth having here are not "the rails rendered". They are the
 * two claims the catalog makes that a regression could quietly withdraw: that
 * nothing reaches a reader without a rights basis on the allowlist, and that a
 * catalog response is metadata and never an address.
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
 * Every item on every rail.
 *
 * A function rather than the loop it used to be inline, because BOTH assertions
 * below are "this list is empty" assertions and an empty catalog satisfies each
 * of them while proving nothing. One of them already guarded itself by counting
 * items; the other did not, so a `/api/v1/catalog/home` that had stopped
 * serving anything would have reported green on "the catalog publishes no media
 * address". Naming the count once means the guard cannot be present in one test
 * and forgotten in the next.
 */
function railItems(body: unknown): Record<string, unknown>[] {
  const rails = isRecord(body) && Array.isArray(body["rails"]) ? body["rails"] : [];
  return rails
    .filter(isRecord)
    .flatMap((rail) => (Array.isArray(rail["items"]) ? rail["items"] : []))
    .filter(isRecord);
}

test("health responds before anything else is believed", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("the home catalog is served, uncacheable, and non-empty", async ({ request }) => {
  const response = await request.get("/api/v1/catalog/home");

  expect(response.status()).toBe(200);
  /* Request-scoped data. A shared cache holding a catalog is how a region or
   * an entitlement decision made for one reader is served to another. */
  expect(response.headers()["cache-control"]).toContain("no-store");

  const body: unknown = await response.json();
  expect(isRecord(body)).toBe(true);
  const rails = isRecord(body) ? body["rails"] : null;
  expect(Array.isArray(rails)).toBe(true);
  expect((rails as unknown[]).length).toBeGreaterThan(0);
});

test("every surfaced item carries a rights basis on the playable allowlist", async ({ request }) => {
  const body: unknown = await (await request.get("/api/v1/catalog/home")).json();
  const items = railItems(body);

  /* Guards the assertion itself: an empty catalog would satisfy the offender
   * check while proving nothing, and this suite would then report green for a
   * catalog that had stopped being served. */
  expect(items.length).toBeGreaterThan(0);

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

  /* Both assertions below pass on an empty response. This is what makes them
   * mean "no item published an address" rather than "there was nothing to
   * look at". */
  expect(railItems(body).length).toBeGreaterThan(0);

  const addressKeys = collectKeys(body).filter((key) => ADDRESS_KEY.test(key));
  expect(addressKeys, "the catalog is metadata; a stream is resolved at playback time").toEqual([]);

  /* Belt and braces on the values, because a media address can also arrive
   * under an innocent key name. The catalog has no legitimate reason to
   * contain an absolute URL of any kind today. */
  const urls = collectStrings(body).filter((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value));
  expect(urls).toEqual([]);
});
