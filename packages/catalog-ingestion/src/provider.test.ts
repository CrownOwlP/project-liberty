import { describe, expect, it } from "vitest";
import {
  LICENSED_CATALOG_SOURCE_IDS,
  isLicensedCatalogSourceId,
  requireProviderSideSearch,
  type CatalogMetadataProvider
} from "./provider";

const base = (over: Partial<CatalogMetadataProvider> = {}): CatalogMetadataProvider => ({
  sourceId: "example-source",
  capabilities: {
    providerSideSearch: false,
    incrementalSince: false,
    reportsDeletions: false,
    maxPageSize: 50
  },
  fetchPage: () => Promise.resolve({ ok: true, records: [], nextCursor: null, withdrawn: [] }),
  ...over
});

describe("the list of licensed catalog sources", () => {
  /*
   * THIS SECTION USED TO BE THE OPPOSITE ASSERTION, AND THE CHANGE IS THE POINT.
   * In round 44 it read "refuses by name, because no catalog provider has been
   * licensed", and its comment said it would fail "the day somebody returns a
   * configured provider, which is exactly when a rights review needs to have
   * happened". That day arrived: on 2026-09-17 the human commander recorded a
   * Licensing decision naming WIKIDATA as the initial catalog metadata source,
   * on PL-0305 as `licensingDecision` and in `control/events.jsonl` as a
   * `decision.licensing` event. The tripwire fired, the decision it was waiting
   * for exists, and the assertion is inverted rather than deleted.
   *
   * `resolveCatalogMetadataProvider` itself is now exercised in
   * `wikidata.test.ts`, where the transport double it needs already lives. What
   * stays here is the part that is about the PORT rather than about any adapter:
   * which source names this repository has a decision for.
   */
  it("names exactly the source the licensing decision named", () => {
    expect([...LICENSED_CATALOG_SOURCE_IDS]).toEqual(["wikidata"]);
  });

  /*
   * WHAT THIS CATCHES: a credentialed source being added to the list without the
   * Credentials escalation that `control/policies.json` reserves to the human
   * commander. The Wikidata decision says so explicitly -- "TMDB and anything
   * else requiring an API key remains a separate Credentials escalation" -- so
   * this is the live tripwire now, in place of the one that fired.
   */
  it("licenses no keyed source", () => {
    for (const keyed of ["tmdb", "omdb", "trakt", "tvdb", "justwatch"]) {
      expect(isLicensedCatalogSourceId(keyed)).toBe(false);
    }
  });

  /*
   * WHAT THIS CATCHES: the list being mutated at runtime. It is frozen for the
   * reason `packages/contracts/src/shared/runtime.ts` gives about its own
   * allowlist: a consumer that could append to it would be granting a licence
   * without editing the file a reviewer reads. A module is always strict, so the
   * write throws rather than failing silently.
   */
  it("cannot be widened by a consumer at runtime", () => {
    const mutable = LICENSED_CATALOG_SOURCE_IDS as string[];
    expect(() => mutable.push("tmdb")).toThrow();
    expect(isLicensedCatalogSourceId("tmdb")).toBe(false);
  });
});

describe("requireProviderSideSearch", () => {
  /*
   * WHAT THIS CATCHES: `searchWorks?.()` being called optionally somewhere. A
   * provider that cannot search must be refused by name, not fall back to
   * listing the whole source and filtering it in memory -- that is the shape
   * only six fixtures can afford, and it is the specific limitation
   * `docs/CATALOG_SOURCE.md` records about the current search surface.
   */
  it("refuses a provider that does not declare provider-side search", () => {
    expect(requireProviderSideSearch(base())).toEqual({
      ok: false,
      reason: "provider_side_search_not_supported"
    });
  });

  /*
   * WHAT THIS CATCHES: the flag and the method disagreeing. A provider that
   * declares the capability but ships no method would otherwise produce
   * `undefined is not a function` on a user's search; a provider with the method
   * and no declaration is a capability nobody reviewed.
   */
  it("refuses when the declaration and the implementation disagree, in either direction", () => {
    const declaredButMissing = base({
      capabilities: { ...base().capabilities, providerSideSearch: true }
    });
    expect(requireProviderSideSearch(declaredButMissing).ok).toBe(false);

    const implementedButUndeclared = base({
      searchWorks: () => Promise.resolve({ ok: true, records: [], nextCursor: null })
    });
    expect(requireProviderSideSearch(implementedButUndeclared).ok).toBe(false);
  });

  it("hands back a bound method when both agree", async () => {
    const provider = base({
      capabilities: { ...base().capabilities, providerSideSearch: true },
      searchWorks(query) {
        return Promise.resolve({
          ok: true,
          records: [{ nativeId: query, sourceRevision: null, crossRefs: [], raw: {} }],
          nextCursor: null
        });
      }
    });

    const guarded = requireProviderSideSearch(provider);
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;

    const result = await guarded.search("matrix", null, 10);
    expect(result.ok && result.records[0]?.nativeId).toBe("matrix");
  });
});
