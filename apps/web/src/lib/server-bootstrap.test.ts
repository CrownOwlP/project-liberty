import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { nodePinnedFetch } from "@liberty/media-inspection/node/pinned-fetch";
import type { ManifestFetchDependencies } from "@liberty/media-inspection";
import { classifyHost } from "@liberty/provider-sdk";
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
  catalogRuntimeFor,
  nodeCatalogTransport,
  readCatalogSourceDeclaration
} from "./server-bootstrap";
import {
  requireCatalogDescription,
  type CatalogIngestionAnswer
} from "./catalog-ingestion-source";
import type { CatalogAnswer } from "./catalog-source";

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
 * NOTHING HERE OPENS A SOCKET, and that is now true for two different reasons
 * rather than one. Most tests in this file never read a page at all:
 * `resolveCatalogMetadataSource` composes a provider and returns it, and nothing
 * is fetched until `describeCatalog()` is called. The regression at the bottom
 * of the file DOES call it, twice, on purpose -- counting those reads is the
 * whole measurement -- and it substitutes `fetchImpl` through the transport
 * parameter the composition root already takes. The egress gate, the host
 * classification and the address pinning in front of that call are the real ones.
 * ---------------------------------------------------------------------- */

/**
 * The refresh policy the configured fixture states, as three plain numbers.
 *
 * NAMED CONSTANTS RATHER THAN LITERALS IN THE FIXTURE, because the regression at
 * the bottom of this file has to reason about them: it advances a clock to an
 * instant it can argue is inside the fresh window, and "one second into a minute"
 * is an argument only if both numbers have names.
 */
const FRESH_FOR_MS = 60_000;
const STALE_AFTER_MS = 300_000;
const MAX_BACKOFF_MS = 600_000;

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
  [CATALOG_SOURCE_ENV_VARS.freshForMs]: String(FRESH_FOR_MS),
  [CATALOG_SOURCE_ENV_VARS.staleAfterMs]: String(STALE_AFTER_MS),
  [CATALOG_SOURCE_ENV_VARS.maxBackoffMs]: String(MAX_BACKOFF_MS),
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

/* -------------------------------------------------------------------------
 * The refresh schedule, which is what PL-0309's corrective is about
 *
 * THE DEFECT THESE TESTS CLOSE. This composition root used to build a runtime
 * with no `schedule`, the adapter resolved the absent field to `null`, and the
 * package read that as `policy_not_stated` -- so a hosted deployment ran a full
 * ingestion pass on EVERY catalog read. Nothing was broken and nothing was
 * logged; the deployment simply kept doing the thing PL-0309 exists to stop.
 *
 * THE POLICY IS CHECKED BY THE PACKAGE AND NOT BY THIS FILE'S EXPECTATIONS. The
 * refusal tests below feed values whose coherence is decided by
 * `validateCatalogRefreshSchedule`, so they would keep meaning the same thing if
 * the package tightened its rule -- which is the property a test that reimplemented
 * the comparison here would lose.
 * ---------------------------------------------------------------------- */
describe("the refresh schedule a configured deployment states", () => {
  /*
   * THE FIELD IS SET, ASSERTED ON THE REGISTERED RUNTIME. This is the narrow
   * statement: what the composition root hands the registry now carries the
   * operator's policy, in the package's own shape, rather than leaving the field
   * absent for the package to read as "no policy".
   */
  it("carries the operator's stated policy onto the registered runtime", () => {
    bootstrapCatalogMetadataSource(configuredEnvironment());

    expect(registeredCatalogIngestionRuntime()?.schedule).toEqual({
      policy: { freshForMs: FRESH_FOR_MS, staleAfterMs: STALE_AFTER_MS },
      maxBackoffMs: MAX_BACKOFF_MS
    });
  });

  /*
   * A CONFIGURED DEPLOYMENT THAT STATES NO SCHEDULE IS REFUSED, AND THIS IS THE
   * BEHAVIOUR CHANGE. Before the corrective this environment registered happily
   * and refreshed per read. It now names the three variables and registers
   * nothing, which is the loud version of the same fact.
   */
  it("refuses a deployment that asked for a source and stated no schedule", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({
        [CATALOG_SOURCE_ENV_VARS.freshForMs]: undefined,
        [CATALOG_SOURCE_ENV_VARS.staleAfterMs]: undefined,
        [CATALOG_SOURCE_ENV_VARS.maxBackoffMs]: undefined
      })
    );

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    for (const name of [
      CATALOG_SOURCE_ENV_VARS.freshForMs,
      CATALOG_SOURCE_ENV_VARS.staleAfterMs,
      CATALOG_SOURCE_ENV_VARS.maxBackoffMs
    ]) {
      expect(outcome.defects.join("\n")).toContain(name);
    }
    expect(registeredCatalogIngestionRuntime()).toBeNull();
  });

  /*
   * A TRANSPOSED POLICY IS CAUGHT AT CONFIGURATION TIME, which is the reason
   * `validateCatalogRefreshSchedule` is exported at all: at runtime this pair
   * would mark literally every answer expired and present to an operator as a
   * provider outage.
   */
  it("refuses a policy whose two bounds are the wrong way round", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({
        [CATALOG_SOURCE_ENV_VARS.freshForMs]: String(STALE_AFTER_MS),
        [CATALOG_SOURCE_ENV_VARS.staleAfterMs]: String(FRESH_FOR_MS)
      })
    );

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    expect(outcome.defects.join("\n")).toContain(CATALOG_SOURCE_ENV_VARS.freshForMs);
    expect(outcome.defects.join("\n")).toContain(CATALOG_SOURCE_ENV_VARS.staleAfterMs);
    expect(registeredCatalogIngestionRuntime()).toBeNull();
  });

  /*
   * AN UNCAPPED BACKOFF IS REFUSED RATHER THAN TREATED AS "NO CAP". An
   * exponential with no cap reaches next Tuesday after a morning of failures, so
   * a provider that came back at noon is not asked again that day.
   */
  it("refuses a backoff cap of zero", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({ [CATALOG_SOURCE_ENV_VARS.maxBackoffMs]: "0" })
    );

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    expect(outcome.defects.join("\n")).toContain(CATALOG_SOURCE_ENV_VARS.maxBackoffMs);
  });

  /*
   * A DURATION THAT IS NOT A NUMBER IS A READING FAILURE, reported against its
   * own variable. `5m` is what an operator actually types, and `Number("5m")` is
   * `NaN` -- which must not reach a scheduler as a bound.
   */
  it("refuses a duration that is not a whole number of milliseconds", () => {
    const outcome = bootstrapCatalogMetadataSource(
      configuredEnvironment({ [CATALOG_SOURCE_ENV_VARS.freshForMs]: "5m" })
    );

    expect(outcome.status).toBe("declaration-refused");
    if (outcome.status !== "declaration-refused") return;
    expect(outcome.defects.join("\n")).toContain(CATALOG_SOURCE_ENV_VARS.freshForMs);
    expect(registeredCatalogIngestionRuntime()).toBeNull();
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
      CATALOG_SOURCE_ENV_VARS.maxPages,
      CATALOG_SOURCE_ENV_VARS.freshForMs,
      CATALOG_SOURCE_ENV_VARS.staleAfterMs,
      CATALOG_SOURCE_ENV_VARS.maxBackoffMs
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

/* -------------------------------------------------------------------------
 * The regression PL-0309's corrective is measured by
 *
 * WHAT THIS DRIVES, AND WHY IT IS NOT A UNIT TEST. Everything above asserts what
 * the composition root PUTS IN the registry. That is not the claim the verdict
 * asked for. The claim is about what a CONFIGURED DEPLOYMENT DOES: that a second
 * catalog read does not go out to the source again. So this goes through the
 * real `bootstrapCatalogMetadataSource`, the real registry, the real adapter,
 * the real scheduler, the real store and the real ingestion pass, and the only
 * thing it substitutes is the socket.
 *
 * THE SUBSTITUTION IS THE TRANSPORT AND NOTHING ELSE. `bootstrapCatalogMetadataSource`
 * already takes `ManifestFetchDependencies` as a parameter with a production
 * default -- the same seam the pinned-fetch assertions above use in the other
 * direction. Everything between the environment and `fetchImpl` is the code a
 * deployment runs.
 *
 * WHAT IS COUNTED. `fetchImpl` calls. One ingestion pass over this scripted
 * source is exactly one of them: the page carries one row, one row is fewer than
 * the page size, and `fetchPage` reports a short page as the end of the
 * enumeration. So "passes" and "fetches" are the same number here, and the
 * number is the measurement.
 *
 * THE CONTRAST IS THE EVIDENCE, NOT THE ASSERTION. A test that only showed one
 * fetch across two reads would also pass if the second read had thrown, been
 * backed off, or never happened. So the same scripted source is driven a second
 * time through a runtime that states no policy, and that one is asserted to
 * fetch twice. The two halves differ in exactly one field.
 *
 * WHY THE SECOND HALF DOES NOT GO THROUGH `bootstrapCatalogMetadataSource`. It
 * cannot: the corrective makes the three schedule variables required, so there
 * is no environment the bootstrap will turn into an unscheduled runtime. That is
 * the point of the change. The unscheduled runtime is therefore built from the
 * SAME `catalogRuntimeFor` output with the `schedule` field removed, and
 * registered through the same registry -- so the comparison is still one field,
 * and `policy_not_stated` is shown to be alive rather than asserted to be.
 * ---------------------------------------------------------------------- */

/** A clock a test advances by hand. Never `Date.now`. */
const stoppedClock = (startMs: number) => {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (byMs: number) => {
      ms += byMs;
    }
  };
};

const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

/**
 * One page of one film, in the shape the Query Service actually answers.
 *
 * THE COLUMNS ARE THE ONES `readRow` READS, and the two control characters are
 * the real ones the packing query joins with -- `wikidata-query.ts` owns both.
 * This is a MINIMAL rather than a recorded response: the recorded fixtures live
 * inside the package and are not exported from its entry point, and this file
 * may not reach past that entry point. What is being measured here is how many
 * times the source is asked, which does not depend on the richness of what it
 * answers.
 *
 * THE ROW IS REFUSED, AND THAT IS CORRECT RATHER THAN CONVENIENT. This
 * deployment states `noRightsBasisEstablished`, that register answers `null` for
 * every item, and `ingestedWorkSchema` refuses a work with no rights block --
 * so the refusal arrives as `record_failed_validation` on the `rights` field
 * rather than as `rights_basis_not_declared`, which is reached only by a record
 * that got past the schema. Either way it is the outcome the rights tests above
 * assert for this deployment: nothing is published.
 *
 * A REFUSAL IS STORED STATE. It is committed by the pass, kept on the snapshot
 * and carried into `withheld`, so serving one twice from the store is exactly as
 * good a demonstration as serving an accepted record would be -- and it avoids
 * this file inventing a rights basis in order to have something to look at.
 */
const ONE_FILM_PAGE = JSON.stringify({
  head: { vars: ["item", "n", "titles", "releaseYear"] },
  results: {
    bindings: [
      {
        item: { type: "uri", value: "http://www.wikidata.org/entity/Q83495" },
        n: { type: "literal", value: "83495" },
        titles: {
          type: "literal",
          value: `en${RECORD_SEPARATOR}The Matrix${UNIT_SEPARATOR}fr${RECORD_SEPARATOR}Matrix`
        },
        releaseYear: { type: "literal", value: "1999" }
      }
    ]
  }
});

/**
 * The production transport with the socket replaced by a counter.
 *
 * `classifyHost` IS THE REAL ONE, and the address it is handed is the one the
 * egress suite in `@liberty/media-inspection` uses for a public host. The gate
 * runs for real on this path -- it resolves, classifies every address, pins them
 * and re-authorises -- so a test that handed it a private or special-use address
 * would get `provider_unreachable` and would be measuring the gate rather than
 * the schedule. Nothing connects to it; `fetchImpl` never opens a socket.
 */
const countingTransport = (
  clock: { now: () => number }
): { readonly transport: ManifestFetchDependencies; readonly fetches: () => number } => {
  let fetches = 0;
  return {
    transport: {
      fetchImpl: () => {
        fetches += 1;
        return Promise.resolve(new Response(ONE_FILM_PAGE, { status: 200 }));
      },
      classifyHost,
      resolveHost: () => Promise.resolve(["93.184.216.34"]),
      now: clock.now
    },
    fetches: () => fetches
  };
};

/**
 * One catalog read, taken the way a request takes one.
 *
 * `resolveCatalogMetadataSource(null)` IS CALLED PER READ, NOT HOISTED. That is
 * what a request does -- the registry builds a source per call and does not hold
 * one -- and it is the harder case for the property being measured: if the store
 * did not outlive the source, each read would find an empty store, each would be
 * due, and the count below would be two.
 *
 * THE ANSWER IS NARROWED WITH A RUNTIME CHECK, NOT ASSUMED. The registry
 * publishes `CatalogMetadataSource`, whose `CatalogAnswer` deliberately carries
 * no freshness vocabulary -- `catalog-source.ts` argues that expressing an age
 * there would import the package's vocabulary into every surface that renders a
 * card, and that argument is not this test's to overturn. So the two fields this
 * test reads are checked to be present before they are read, and a source that
 * did not carry them fails here by name instead of silently reading `undefined`.
 */
const readTheCatalogOnce = async (): Promise<CatalogIngestionAnswer> => {
  const resolution = resolveCatalogMetadataSource(null);
  expect(resolution.status).toBe("configured");
  if (resolution.status !== "configured") throw new Error("the registry did not answer configured");

  const describe = requireCatalogDescription(resolution.source);
  expect(describe).not.toBeNull();
  if (describe === null) throw new Error("the configured source cannot describe itself");

  const answer: CatalogAnswer = await describe();
  if (!("refresh" in answer) || !("freshness" in answer)) {
    throw new Error("the configured source did not answer with the ingestion adapter's answer");
  }
  return answer as CatalogIngestionAnswer;
};

/** Two reads, `betweenReadsMs` apart on a clock a test moves by hand. */
const readTheCatalogTwice = async (
  clock: { advance: (byMs: number) => void },
  betweenReadsMs: number
): Promise<{ readonly first: CatalogIngestionAnswer; readonly second: CatalogIngestionAnswer }> => {
  const first = await readTheCatalogOnce();
  clock.advance(betweenReadsMs);
  const second = await readTheCatalogOnce();
  return { first, second };
};

describe("a configured deployment, read twice inside its fresh window", () => {
  /*
   * ITEM 6. Two catalog reads, one second apart, under a policy that calls an
   * answer current for a minute. The source is asked ONCE.
   */
  it("asks the source once and serves the second read from stored state", async () => {
    const clock = stoppedClock(Date.parse("2026-09-22T12:00:00.000Z"));
    const { transport, fetches } = countingTransport(clock);

    expect(bootstrapCatalogMetadataSource(configuredEnvironment(), transport).status).toBe(
      "registered"
    );

    const { first, second } = await readTheCatalogTwice(clock, 1_000);

    expect(fetches()).toBe(1);

    /*
     * AND THE SECOND READ IS AN ANSWER, not a silence. A read that returned
     * nothing would also have fetched nothing, so the count alone proves less
     * than it looks: this is the assertion that the deployment SERVED something,
     * that it served the same thing, and that it said where it came from.
     */
    expect(first.refresh.attempted).toBe(true);
    expect(first.refresh.scheduleReason).toBe("no_stored_state");

    expect(second.refresh.attempted).toBe(false);
    expect(second.refresh.servedFromStoredState).toBe(true);
    expect(second.refresh.scheduleReason).toBe("state_fresh");
    expect(second.refresh.consecutiveFailures).toBe(0);

    expect(second.state).toBe(first.state);
    expect(second.withheld).toEqual(first.withheld);
    expect(second.withheld).toEqual([
      { recordId: "Q83495", reason: "record_failed_validation" }
    ]);
    expect(second.observedAt).toBe(first.observedAt);

    /*
     * `state_fresh` RATHER THAN `backing_off` IS THE HALF THAT MATTERS. A pass
     * that had failed would also suppress the second fetch, and would do it for
     * the wrong reason -- so the freshness verdict is read too, against the
     * operator's own policy.
     */
    expect(second.freshness?.freshness).toBe("fresh");
    expect(second.freshness?.policy).toEqual({
      freshForMs: FRESH_FOR_MS,
      staleAfterMs: STALE_AFTER_MS
    });
    expect(second.refresh.nextDueAtMs).toBe(Date.parse("2026-09-22T12:01:00.000Z"));
  });

  /*
   * THE CONTRAST. The same scripted source, the same two reads, the same
   * interval -- and a runtime that states no policy. It fetches twice, which is
   * what this deployment did before the corrective and what
   * `policy_not_stated` still honestly means.
   */
  it("asks the source twice when the runtime states no policy at all", async () => {
    const clock = stoppedClock(Date.parse("2026-09-22T12:00:00.000Z"));
    const { transport, fetches } = countingTransport(clock);

    const read = readCatalogSourceDeclaration(configuredEnvironment());
    expect(read.status).toBe("declared");
    if (read.status !== "declared") return;

    // The same runtime the bootstrap would register, MINUS the one field.
    const { schedule: _stated, ...unscheduled } = catalogRuntimeFor(read.declaration, transport);
    expect(_stated).not.toBeUndefined();
    registerCatalogIngestionRuntime(unscheduled);

    const { first, second } = await readTheCatalogTwice(clock, 1_000);

    expect(fetches()).toBe(2);
    expect(first.refresh.scheduleReason).toBe("policy_not_stated");
    expect(second.refresh.scheduleReason).toBe("policy_not_stated");
    expect(second.refresh.attempted).toBe(true);

    /*
     * AND NOTHING CLAIMS AN AGE. No policy, no verdict -- an answer is not
     * described as fresh against a bound nobody wrote.
     */
    expect(first.freshness).toBeNull();
    expect(second.freshness).toBeNull();
  });
});
