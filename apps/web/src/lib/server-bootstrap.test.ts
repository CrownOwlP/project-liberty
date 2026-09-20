import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { nodePinnedFetch } from "@liberty/media-inspection/node/pinned-fetch";
import {
  LICENSED_CATALOG_SOURCE_IDS,
  WIKIDATA_CC0_HOSTS,
  WIKIDATA_SOURCE_ID,
  noRightsBasisEstablished
} from "@liberty/catalog-ingestion";
import {
  registerCatalogIngestionRuntime,
  registeredCatalogIngestionRuntime,
  resolveCatalogMetadataSource
} from "./catalog-source-registry";
import {
  CATALOG_SOURCE_ENV_VARS,
  bootstrapCatalogMetadataSource,
  nodeCatalogTransport
} from "./server-bootstrap";

/* -------------------------------------------------------------------------
 * Driving the production composition root
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: `registerCatalogIngestionRuntime` had
 * no caller, so a hosted deployment answered `no_metadata_source_configured`
 * however it was configured, and a registration nobody has watched fire is not
 * known to work.
 *
 * EVERY TEST HERE OBSERVES THE REGISTRY THE WAY A REQUEST DOES -- through
 * `resolveCatalogMetadataSource(null)` with NO runtime argument, so the answer
 * comes from what the bootstrap actually registered in module state rather than
 * from a value this file handed the accessor. `catalog-source-registry.test.ts`
 * already proves what the accessor does with a runtime PASSED to it; that is a
 * different statement and it was already true before this round.
 *
 * `null` FOR THE ENVIRONMENT IS THE DEPLOYMENT. Under vitest `NODE_ENV` is
 * `test`, so `NonDeploymentEnvironment.classify()` would issue a real capability
 * and the fixtures would answer -- which is exactly what must NOT decide these
 * assertions. `null` is what `classify()` answers in a hosted process.
 *
 * NOTHING HERE OPENS A SOCKET, including the tests that use the REAL production
 * transport. `resolveCatalogMetadataSource` composes a provider and returns it;
 * a page is read only by `describeCatalog()`, which no test in this file calls.
 * ---------------------------------------------------------------------- */

/**
 * A fully-stated deployment, as an operator's environment.
 *
 * THE SOURCE NAME IS READ OUT OF THE PACKAGE'S FROZEN LIST rather than written
 * as a literal, for the reason `catalog-ingestion-source.test.ts` gives: the
 * licensing decision is an initial source choice and not an exclusive mandate,
 * and the day a second source is licensed is a day this test should keep
 * passing unchanged.
 */
const configuredEnvironment = (
  over: Readonly<Record<string, string | undefined>> = {}
): Record<string, string | undefined> => ({
  [CATALOG_SOURCE_ENV_VARS.sourceId]: LICENSED_CATALOG_SOURCE_IDS[0] ?? "",
  [CATALOG_SOURCE_ENV_VARS.userAgent]:
    "LibertyCatalog/0.1 (https://liberty.example.test; ops@example.test)",
  [CATALOG_SOURCE_ENV_VARS.classQid]: "Q11424",
  [CATALOG_SOURCE_ENV_VARS.workKind]: "movie",
  [CATALOG_SOURCE_ENV_VARS.locales]: "en,fr",
  [CATALOG_SOURCE_ENV_VARS.territory]: "GB",
  [CATALOG_SOURCE_ENV_VARS.unstatedAvailability]: "refuse",
  [CATALOG_SOURCE_ENV_VARS.maxPages]: "4",
  ...over
});

afterEach(() => {
  registerCatalogIngestionRuntime(null);
});

describe("an unconfigured deployment", () => {
  /*
   * THE PROPERTY THE WHOLE ROUND IS MEASURED AGAINST TWICE. This one says the
   * wiring did not turn "nothing configured" into "something defaulted". A
   * bootstrap that reached for a source because none was named would be the
   * hidden configured source the PL-0305 review forbade, and it would pass every
   * other test in this file.
   */
  it("registers nothing and is still refused by name", () => {
    const outcome = bootstrapCatalogMetadataSource({});

    expect(outcome.status).toBe("not-requested");
    expect(registeredCatalogIngestionRuntime()).toBeNull();

    const resolution = resolveCatalogMetadataSource(null);
    expect(resolution.status).toBe("not-configured");
    if (resolution.status !== "not-configured") return;
    expect(resolution.reason).toBe("no_metadata_source_configured");
  });

  /*
   * A PROCESS ENVIRONMENT IS NEVER EMPTY, and "not requested" must survive one
   * that is full of everything else this application reads.
   */
  it("is unmoved by an environment full of other variables", () => {
    const outcome = bootstrapCatalogMetadataSource({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://liberty@localhost:5432/liberty",
      LIBERTY_BUILD_TARGET: "web",
      LIBERTY_CATALOG_API_KEY: "not-read-by-anything"
    });

    expect(outcome.status).toBe("not-requested");
    expect(registeredCatalogIngestionRuntime()).toBeNull();
  });
});

describe("a deployment whose operator asked for the licensed source", () => {
  /*
   * THE REGRESSION THIS TASK EXISTS FOR. The composition root runs with the
   * production transport, and the registry -- asked the way a request asks it --
   * answers with a configured source instead of the refusal it answered before.
   */
  it("is registered by the composition root and resolves configured", () => {
    const outcome = bootstrapCatalogMetadataSource(configuredEnvironment());

    expect(outcome.status).toBe("registered");
    if (outcome.status !== "registered") return;
    expect(outcome.sourceId).toBe(WIKIDATA_SOURCE_ID);

    const resolution = resolveCatalogMetadataSource(null);
    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.source.sourceId).toBe(WIKIDATA_SOURCE_ID);
  });

  /*
   * AND IT IS NOT THE FIXTURES, asserted negatively and separately: a hosted
   * deployment serving six invented films as though they were the catalog is the
   * worst available outcome of wiring this up.
   */
  it("is never served the demo fixtures", () => {
    bootstrapCatalogMetadataSource(configuredEnvironment());

    const resolution = resolveCatalogMetadataSource(null);
    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.source.sourceId).not.toBe("demo-fixtures");
  });

  /*
   * THE TRANSPORT IS THE PINNED ONE, ASSERTED BY REFERENCE IDENTITY rather than
   * by behaviour, the way `net-policy-boundary.test.ts` asserts a boundary: a
   * second fetch path that happened to work would satisfy any behavioural check
   * and is exactly what must not exist here.
   */
  it("reaches the network through the Node pinned fetch and nothing else", () => {
    bootstrapCatalogMetadataSource(configuredEnvironment());

    const runtime = registeredCatalogIngestionRuntime();
    expect(runtime).not.toBeNull();
    expect(runtime?.provider.transport.fetchImpl).toBe(nodePinnedFetch);
    expect(nodeCatalogTransport().fetchImpl).toBe(nodePinnedFetch);
  });

  /*
   * THE EGRESS POLICY IS THE LICENSED ONE AND NO OPERATOR SUPPLIES IT. An
   * allowlist an operator could widen is not an allowlist, and the package
   * refuses a Wikidata provider whose policy names anything but these two hosts.
   */
  it("is composed over the licensed hosts and admits no loopback", () => {
    bootstrapCatalogMetadataSource(
      configuredEnvironment({ LIBERTY_CATALOG_ALLOWED_HOSTS: "169.254.169.254" })
    );

    const egress = registeredCatalogIngestionRuntime()?.provider.document.egress;
    expect(egress?.allowedHosts).toEqual([...WIKIDATA_CC0_HOSTS]);
    expect(egress?.allowLoopback).toBe(false);
  });

  /*
   * NO RIGHTS BASIS IS INVENTED BY WIRING A SOURCE UP. The register is the
   * package's own "nobody has done the rights work" value, by reference, so this
   * deployment publishes nothing and says per record why. The rights register is
   * PL-0308's stated non-goal; what it must not do is quietly supply one.
   */
  it("states no rights basis", () => {
    bootstrapCatalogMetadataSource(configuredEnvironment());

    expect(registeredCatalogIngestionRuntime()?.provider.rightsRegister).toBe(
      noRightsBasisEstablished
    );
  });

  /*
   * THE OPERATOR'S STATED READINGS ARRIVE INTACT. Each of these is a deployment
   * decision with a consequence somebody owns, and a value that was read but
   * dropped would show up as a catalog that behaved like a default.
   */
  it("carries the operator's stated readings into the runtime", () => {
    bootstrapCatalogMetadataSource(configuredEnvironment());

    const runtime = registeredCatalogIngestionRuntime();
    expect(runtime?.read.locales).toEqual(["en", "fr"]);
    expect(runtime?.read.territory).toBe("GB");
    expect(runtime?.read.unstatedAvailability).toBe("refuse");
    expect(runtime?.read.maxPages).toBe(4);
    expect(runtime?.provider.selection).toEqual({
      classQid: "Q11424",
      kind: "movie",
      locales: ["en", "fr"]
    });
  });
});

describe("a deployment that asked for a source and did not finish saying which", () => {
  /*
   * HALF-CONFIGURED IS NOT CONFIGURED, AND IT IS NOT SILENT. Every missing
   * variable is named at once rather than one per restart, and nothing is
   * registered -- so the deployment is refused by name and an operator has the
   * whole list.
   */
  it("registers nothing and names every variable it is missing", () => {
    const outcome = bootstrapCatalogMetadataSource({
      [CATALOG_SOURCE_ENV_VARS.sourceId]: WIKIDATA_SOURCE_ID
    });

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    for (const name of [
      CATALOG_SOURCE_ENV_VARS.userAgent,
      CATALOG_SOURCE_ENV_VARS.classQid,
      CATALOG_SOURCE_ENV_VARS.workKind,
      CATALOG_SOURCE_ENV_VARS.locales,
      CATALOG_SOURCE_ENV_VARS.territory,
      CATALOG_SOURCE_ENV_VARS.unstatedAvailability,
      CATALOG_SOURCE_ENV_VARS.maxPages
    ]) {
      expect(outcome.defects.join("\n")).toContain(name);
    }

    expect(registeredCatalogIngestionRuntime()).toBeNull();
    const resolution = resolveCatalogMetadataSource(null);
    expect(resolution.status).toBe("not-configured");
  });

  /*
   * A VALUE THAT IS PRESENT AND WRONG IS REPORTED AGAINST THE VARIABLE THAT
   * CARRIES IT. `gb` is the spelling an operator actually types, and the
   * territory vocabulary is the package's own schema rather than a check this
   * module invented.
   */
  it("refuses a malformed value under its own variable name", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({ [CATALOG_SOURCE_ENV_VARS.territory]: "gb" })
    );

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    expect(outcome.defects.join("\n")).toContain(CATALOG_SOURCE_ENV_VARS.territory);
    expect(registeredCatalogIngestionRuntime()).toBeNull();
  });

  /*
   * A LOCALE LIST THAT IS PUNCTUATION IS AN EMPTY LOCALE LIST, and an empty one
   * is refused rather than silently becoming "whatever the source prefers".
   */
  it("refuses a locale list with nothing in it", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({ [CATALOG_SOURCE_ENV_VARS.locales]: " , , " })
    );

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    expect(outcome.defects.join("\n")).toContain(CATALOG_SOURCE_ENV_VARS.locales);
  });

  /*
   * A SOURCE NAME NOBODY LICENSED IS REGISTERED AND REFUSED BY THE PACKAGE, not
   * quietly dropped here. The distinction is the whole reason the registry has
   * two refusal reasons: telling an operator who configured a source to
   * "configure a source" sends them the wrong way.
   */
  it("hands an unlicensed source name to the package and gets its refusal", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({ [CATALOG_SOURCE_ENV_VARS.sourceId]: "imdb" })
    );

    expect(outcome.status).toBe("registered");

    const resolution = resolveCatalogMetadataSource(null);
    expect(resolution.status).toBe("not-configured");
    if (resolution.status !== "not-configured") return;
    expect(resolution.reason).toBe("catalog_metadata_source_configuration_refused");
    expect(resolution.detail).toContain("imdb");
  });
});

describe("the variables this module reads", () => {
  /*
   * NO CREDENTIAL IS INTRODUCED, ASSERTED OVER THE NAMES RATHER THAN ASSERTED IN
   * PROSE. The initial licensed source needs none, and an ambient key read here
   * would be the hidden credentialed source the PL-0305 review forbade. Two
   * halves, because either alone is easy to get past: no declared name is
   * credential-shaped, and the module mentions no `LIBERTY_` name it has not
   * declared -- so a second, undeclared read cannot hide in the file.
   */
  it("are exactly the declared ones, and none of them is a secret", () => {
    const declared = Object.values(CATALOG_SOURCE_ENV_VARS);
    for (const name of declared) {
      expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|CRED|AUTH/i);
    }

    const source = readFileSync(new URL("./server-bootstrap.ts", import.meta.url), "utf8");
    const mentioned = new Set(source.match(/LIBERTY_[A-Z0-9_]+/g) ?? []);
    expect([...mentioned].sort()).toEqual([...declared].sort());
  });
});

describe("the instrumentation entry point", () => {
  /*
   * THE LAST LINK, DRIVEN RATHER THAN ASSUMED. Everything above proves the
   * composition root works when something calls it; this proves the file Next
   * loads is the something. It is here rather than beside `instrumentation.ts`
   * because a framework convention file has no test of its own -- and what is
   * worth checking about it is its effect on THIS module's registry, which is
   * what these two tests read.
   *
   * THE REAL `process.env` IS MUTATED AND RESTORED, deliberately: `register`
   * takes no arguments, by design, so the only way to drive it is the way Next
   * does. Vitest isolates a file's module state, and the `finally` puts every
   * name back exactly as it was, including the ones that were absent.
   */
  const withEnvironment = async (
    overrides: Readonly<Record<string, string | undefined>>,
    body: () => Promise<void>
  ): Promise<void> => {
    const previous = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(overrides)) {
      previous.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      await body();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  /*
   * THE EDGE RUNTIME LOADS NOTHING. Next compiles an instrumentation entry for
   * it too, and `server-bootstrap.ts` imports `node:dns/promises`. The guard is
   * what keeps that module out of a bundle that cannot hold it, so a guard that
   * stopped working would be a build failure rather than a subtle one -- and
   * this is the assertion that it is still there.
   */
  it("does nothing outside the Node runtime", async () => {
    const { register } = await import("../instrumentation");

    await withEnvironment({ NEXT_RUNTIME: "edge" }, async () => {
      await register();
    });

    expect(registeredCatalogIngestionRuntime()).toBeNull();
  });

  /*
   * AND IN THE NODE RUNTIME IT REGISTERS, FROM THE REAL ENVIRONMENT. This is
   * the whole of PL-0308 in one call: the file Next loads, reading the process
   * an operator configured, ending in a registry that answers `configured`.
   */
  it("runs the bootstrap in the Node runtime and the registry then resolves configured", async () => {
    const { register } = await import("../instrumentation");
    const logged = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await withEnvironment(
        { NEXT_RUNTIME: "nodejs", ...configuredEnvironment() },
        async () => {
          await register();
        }
      );

      const resolution = resolveCatalogMetadataSource(null);
      expect(resolution.status).toBe("configured");
      if (resolution.status !== "configured") return;
      expect(resolution.source.sourceId).toBe(WIKIDATA_SOURCE_ID);
      expect(logged).toHaveBeenCalledWith(
        `catalog metadata source: runtime registered for ${WIKIDATA_SOURCE_ID}`
      );
    } finally {
      logged.mockRestore();
    }
  });

  /*
   * A PROCESS THAT CONFIGURED NOTHING IS STILL TOLD SO AT STARTUP. "No source
   * requested" is the state an operator most needs stated, because at the
   * browse surfaces it is indistinguishable from a source that is configured
   * and publishing nothing.
   */
  it("says so at startup when nothing is configured", async () => {
    const { register } = await import("../instrumentation");
    const logged = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const cleared = Object.fromEntries(
      Object.values(CATALOG_SOURCE_ENV_VARS).map((name) => [name, undefined])
    );

    try {
      await withEnvironment({ NEXT_RUNTIME: "nodejs", ...cleared }, async () => {
        await register();
      });

      expect(registeredCatalogIngestionRuntime()).toBeNull();
      expect(logged).toHaveBeenCalledWith(
        `catalog metadata source: none requested (set ${CATALOG_SOURCE_ENV_VARS.sourceId} to configure one)`
      );
    } finally {
      logged.mockRestore();
    }
  });
});
