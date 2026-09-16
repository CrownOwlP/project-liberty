import { describe, expect, it } from "vitest";
import {
  requireProviderSideSearch,
  resolveCatalogMetadataProvider,
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

describe("resolveCatalogMetadataProvider", () => {
  /*
   * WHAT THIS CATCHES: a provider being wired in without the licensing decision
   * that `control/policies.json` reserves to the human commander. This assertion
   * fails the day somebody returns a configured provider from here, which is
   * exactly when a rights review needs to have happened -- and it fails loudly
   * rather than letting the wiring land quietly beside other work.
   *
   * It is NOT a claim that the refusal is permanent. It is a tripwire on the one
   * function that can change the answer.
   */
  it("refuses by name, because no catalog provider has been licensed", () => {
    expect(resolveCatalogMetadataProvider()).toEqual({
      status: "not-configured",
      reason: "no_catalog_provider_licensed"
    });
  });

  /*
   * WHAT THIS CATCHES: a credential or a source name being introduced through
   * configuration. The resolver declares no parameter, so there is no value an
   * operator could set that changes what this build's catalog is -- and a later
   * edit that added one would change this arity.
   */
  it("takes no configuration, so nothing about the catalog is settable at runtime", () => {
    expect(resolveCatalogMetadataProvider).toHaveLength(0);
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
