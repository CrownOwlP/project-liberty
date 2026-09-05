import { describe, expect, it } from "vitest";
import {
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment
} from "../app/api/deployment-environment";
import type { CatalogMetadataRecord } from "./catalog-source";
import {
  resolveCatalogMetadataSource,
  type CatalogMetadataSourceResolution,
  type CatalogSourceUnavailableReason
} from "./catalog-source-registry";
import { demoCatalog, demoCatalogSource } from "./demo-catalog";

/*
 * Environments that are not on the allowlist, written out rather than derived.
 *
 * A list computed as "everything except `NON_DEPLOYMENT_ENVIRONMENTS`" is not
 * computable -- the complement of a two-element allowlist over all strings is
 * infinite -- so these are the values a real deployment actually reports, plus
 * the near-misses an allowlist exists to catch: a capitalised spelling, a
 * hosting platform's own stage names, and the empty string.
 *
 * `""` IS HOW AN UNSET VARIABLE IS EXPRESSED HERE, and it is faithful rather
 * than convenient. Passing `undefined` explicitly would re-enter the default
 * parameter and read `process.env.NODE_ENV`, which under vitest is `test` -- so
 * a test that passed `undefined` expecting a refusal would be asserting the
 * opposite of what it appeared to. `classify` maps an unset variable to `""`
 * with `?? ""` for exactly this reason: neither is a claim to be local.
 */
const DEPLOYMENT_ENVIRONMENTS = [
  "production",
  "Production",
  "PRODUCTION",
  "staging",
  "preview",
  "prod",
  "ci",
  ""
] as const;

/**
 * Everything a resolution OBSERVABLY says, reduced to comparable values.
 *
 * A RESOLUTION IS NOT COMPARABLE BY VALUE AND WAS NEVER MEANT TO BE. On the
 * configured branch it carries a `CatalogMetadataSource`, whose `listRecords`
 * and `findRecord` are functions -- `demoCatalogSource` builds a fresh object
 * with fresh closures on every call, as an interface-typed factory is entitled
 * to. `toEqual` compares function-valued properties by REFERENCE and prints
 * every closure identically, so two behaviourally identical resolutions failed
 * with "compared values have no visual difference": an assertion about closure
 * identity wearing the costume of an assertion about the registry.
 *
 * The registry is not the thing that should change to make that comparison
 * work. Memoizing a source per environment would make `toEqual` pass by turning
 * it into `toBe`, and it would buy nothing in exchange: `DEMO_RECORDS` is a
 * module-level constant, so a call allocates one small object and two closures
 * and rebuilds no fixtures. It would also commit the port to a process-wide
 * singleton, which is a lifecycle decision belonging to whichever real provider
 * eventually lands here -- a provider holding a connection or a refresh timer
 * may well want per-call construction -- and it would put a module-scope cache
 * in the one module whose documented rule is that the environment answer is
 * never frozen at module scope.
 *
 * So the facts are extracted instead: WHICH branch, WHICH source answered, and
 * WHAT it publishes. That is the whole of what a caller of this function can
 * see, which makes it the whole of what a test of it should compare.
 */
type ObservedResolution =
  | {
      readonly status: "configured";
      readonly sourceId: string;
      readonly records: readonly CatalogMetadataRecord[];
    }
  | { readonly status: "not-configured"; readonly reason: CatalogSourceUnavailableReason };

/** `await` because the port permits a source to answer with a promise. */
async function observe(
  resolution: CatalogMetadataSourceResolution
): Promise<ObservedResolution> {
  if (resolution.status === "not-configured") {
    return { status: "not-configured", reason: resolution.reason };
  }
  return {
    status: "configured",
    sourceId: resolution.source.sourceId,
    records: await resolution.source.listRecords()
  };
}

describe("resolveCatalogMetadataSource", () => {
  /*
   * Tied to the allowlist rather than restating it. If a value is ever added to
   * `NON_DEPLOYMENT_ENVIRONMENTS`, this test starts covering it without being
   * edited -- and if the registry ever stops consulting that array, this fails.
   */
  it("configures the fixture source for every environment the allowlist admits", () => {
    expect(NON_DEPLOYMENT_ENVIRONMENTS.length).toBeGreaterThan(0);

    for (const nodeEnv of NON_DEPLOYMENT_ENVIRONMENTS) {
      const resolution = resolveCatalogMetadataSource(nodeEnv);

      expect(resolution.status, nodeEnv).toBe("configured");
      if (resolution.status !== "configured") continue;
      expect(resolution.source.sourceId, nodeEnv).toBe("demo-fixtures");
    }
  });

  /*
   * THE ONE THAT MATTERS. A hosted build has no metadata source at all, so it
   * cannot serve six invented titles as though they were the catalog. The
   * refusal is a named reason and not an empty list, because "no provider is
   * configured" has an operator remedy and "the catalog is empty" does not.
   */
  it("configures nothing on a deployment, with a stated reason", () => {
    for (const nodeEnv of DEPLOYMENT_ENVIRONMENTS) {
      const resolution = resolveCatalogMetadataSource(nodeEnv);

      expect(resolution, JSON.stringify(nodeEnv)).toEqual({
        status: "not-configured",
        reason: "no_metadata_source_configured"
      });
    }
  });

  /*
   * The default argument is a read of the process boundary at CALL time, not a
   * frozen module-scope value. Compared against the same read rather than
   * against a hardcoded verdict, so this asserts the wiring without also
   * asserting which environment the suite happens to run in.
   *
   * COMPARED ON OBSERVABLE FACTS RATHER THAN ON THE TWO OBJECTS. See `observe`
   * above: the configured branch carries closures, two calls build two of them,
   * and `toEqual` reads that as a difference while printing none. What this
   * asserts is what it always meant to assert -- that the parameterless call
   * lands on the same branch, with the same source, publishing the same records,
   * as the call that states `process.env.NODE_ENV` explicitly.
   *
   * It is not a vacuous comparison of two refusals: vitest sets `NODE_ENV=test`,
   * which `NON_DEPLOYMENT_ENVIRONMENTS` admits, so both sides are configured
   * resolutions here. A default argument that read anything else -- a
   * module-scope snapshot taken before the environment was set, a hardcoded
   * value, nothing at all -- puts the two calls on different branches and this
   * fails.
   */
  it("reads the process environment when given no argument", async () => {
    expect(await observe(resolveCatalogMetadataSource())).toEqual(
      await observe(resolveCatalogMetadataSource(process.env.NODE_ENV))
    );
  });
});

/*
 * THERE IS NO `readFixtureCatalogItems` SUITE ANY MORE.
 *
 * The registry used to export a second, synchronous accessor that reached
 * `demoCatalogSource` directly, and this file asserted both of its directions.
 * It existed only to be the default argument of `getHomeCatalog` in
 * `lib/catalog.ts`, which existed only to serve the home API route
 * synchronously; that route now awaits `loadHomeCatalog`, so both functions had
 * nothing but test callers left and were deleted rather than kept alive for
 * them.
 *
 * Nothing it proved has been lost. The `resolveCatalogMetadataSource` tests above
 * cover both directions of the environment gate, and "the demo metadata source"
 * below covers what the fixture source publishes and that every record declares
 * a rights basis agreeing with its item -- which is what made `selectDeclaredItems`
 * pass all six items through the deleted accessor in the first place.
 */

describe("the demo metadata source", () => {
  /*
   * OBTAINING ONE REQUIRES HANDLING THE REFUSAL, and this test has to do it in
   * full view: `classify` answers `NonDeploymentEnvironment | null` and
   * `demoCatalogSource` takes the non-null type, so there is no expression that
   * reaches the fixtures without this branch. That is the whole control -- a
   * runtime `if` in the registry could be deleted and everything would still
   * compile.
   */
  const environment = NonDeploymentEnvironment.classify("development");
  if (environment === null) {
    throw new Error("development is on NON_DEPLOYMENT_ENVIRONMENTS and must classify");
  }
  const source = demoCatalogSource(environment);

  it("reports the environment that admitted it, rather than re-reading one", () => {
    expect(source.environment).toBe("development");
    expect(demoCatalogSource(environment).environment).toBe(environment.nodeEnv);
  });

  /*
   * Every fixture states a basis, and states the same category the published
   * item carries -- so none of them is dropped by `selectDeclaredItems`, and the
   * fixture set the home rails show is the whole fixture set. The reference is
   * `null` because these works have no entry in any rights register; a token
   * naming a record that does not exist would be a fabrication.
   */
  it("declares a rights basis for every record, agreeing with the item", () => {
    const records = source.listRecords();

    expect(records.length).toBe(demoCatalog.length);
    for (const entry of records) {
      expect(entry.rights, entry.item.id).not.toBeNull();
      expect(entry.rights?.category, entry.item.id).toBe(entry.item.rights);
      expect(entry.rights?.reference, entry.item.id).toBeNull();
    }
  });

  it("publishes exactly the items demoCatalog exposes, in the same order", () => {
    expect(source.listRecords().map((entry) => entry.item)).toEqual([...demoCatalog]);
  });

  it("resolves a known id to its own record", () => {
    const found = source.findRecord("northstar");

    expect(found).not.toBeNull();
    expect(found?.item.id).toBe("northstar");
    expect(found?.item.kind).toBe("series");
  });

  /*
   * `null` for an id nothing knows about, which is the port's not-found. A
   * source that cannot answer at all throws instead, so the two stay
   * distinguishable at the boundary rather than being inferred from an
   * empty-looking payload.
   */
  it("answers null for an id it does not know, including the empty one", () => {
    expect(source.findRecord("no-such-title")).toBeNull();
    expect(source.findRecord("")).toBeNull();
    /* Episode ids are generated by the title surface, not held by the catalog. */
    expect(source.findRecord("northstar-s1e1")).toBeNull();
  });
});
