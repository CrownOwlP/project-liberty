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
  const rails = isRecord(body) && Array.isArray(body["rails"]) ? body["rails"] : [];

  const offenders: string[] = [];
  let itemCount = 0;

  for (const rail of rails) {
    if (!isRecord(rail) || !Array.isArray(rail["items"])) continue;
    for (const item of rail["items"]) {
      if (!isRecord(item)) continue;
      itemCount += 1;
      const rights = item["rights"];
      if (typeof rights !== "string" || !PLAYABLE_RIGHTS.includes(rights)) {
        offenders.push(`${String(item["id"])} carries rights ${JSON.stringify(rights)}`);
      }
    }
  }

  /* Guards the assertion itself: an empty catalog would pass the loop above
   * while proving nothing, and this suite would then report green for a
   * catalog that had stopped being served. */
  expect(itemCount).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test("the catalog publishes no media address, under any key name", async ({ request }) => {
  const body: unknown = await (await request.get("/api/v1/catalog/home")).json();

  const addressKeys = collectKeys(body).filter((key) => ADDRESS_KEY.test(key));
  expect(addressKeys, "the catalog is metadata; a stream is resolved at playback time").toEqual([]);

  /* Belt and braces on the values, because a media address can also arrive
   * under an innocent key name. The catalog has no legitimate reason to
   * contain an absolute URL of any kind today. */
  const urls = collectStrings(body).filter((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value));
  expect(urls).toEqual([]);
});
