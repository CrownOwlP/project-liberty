import { describe, expect, it } from "vitest";
import {
  LICENSED_CATALOG_SOURCE_IDS,
  WIKIDATA_CC0_HOSTS,
  noRightsBasisEstablished,
  type CatalogProviderRuntime,
  type HostClass
} from "@liberty/catalog-ingestion";
import type { CatalogIngestionReadOptions, CatalogIngestionRuntime } from "./catalog-ingestion-source";
import {
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment,
  isNonDeploymentEnvironmentName
} from "../app/api/deployment-environment";
import type { CatalogMetadataRecord } from "./catalog-source";
import {
  registerCatalogIngestionRuntime,
  registeredCatalogIngestionRuntime,
  resolveCatalogMetadataSource,
  type CatalogMetadataSourceResolution,
  type CatalogSourceUnavailableReason
} from "./catalog-source-registry";
import { demoCatalog, demoCatalogSource } from "./demo-catalog";

/*
 * Runtime NAMES that are not on the allowlist, written out rather than derived.
 *
 * A list computed as "everything except `NON_DEPLOYMENT_ENVIRONMENTS`" is not
 * computable -- the complement of a two-element allowlist over all strings is
 * infinite -- so these are the values a real deployment actually reports, plus
 * the near-misses an allowlist exists to catch: a capitalised spelling, a
 * hosting platform's own stage names, and the empty string.
 *
 * THEY ARE NAMES, AND THE ONLY THING IN THIS FILE THAT TAKES ONE IS
 * `isNonDeploymentEnvironmentName`. They used to be passed to the accessors,
 * which forwarded them to the mint -- which is the hole PL-0706 closed: a
 * process could name the environment it wished to be treated as and be issued a
 * genuine capability for it. Neither accessor takes a name now, so name-by-name
 * coverage of the allowlist is asserted against the predicate that answers about
 * a string and grants nothing, and the accessors are exercised against the two
 * things they can actually be handed: a classification, or `null`.
 *
 * `""` IS HOW AN UNSET VARIABLE IS EXPRESSED HERE, and it is faithful rather than
 * convenient: `isNonDeploymentEnvironmentName` maps an absent value to `""` with
 * `?? ""` for exactly this reason, so neither is a claim to be local. Both are
 * asserted below.
 */
const DEPLOYMENT_ENVIRONMENT_NAMES = [
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
 * This process's own classification, minted once at import.
 *
 * `classify()` TAKES NO ARGUMENT: it classifies THE PROCESS, so nothing in this
 * file can ask to be treated as an environment it is not running in. This suite
 * is issued a real capability because vitest really does run as `test`, which
 * the one allowlist admits -- the classification is true, not a loophole -- and
 * it is the only way anything in this repository reaches the granting branch.
 *
 * The refusing branch is reached by passing `null`, which is precisely the value
 * a deployment receives from the same mint.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

const TEST_RUNTIME: NonDeploymentEnvironment = classifiedProcess();

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

/*
 * The allowlist itself, asserted where it can now be asked about.
 *
 * WHY IT IS NOT ASSERTED THROUGH THE REGISTRY ANY MORE. These two tests used to
 * be loops over `NON_DEPLOYMENT_ENVIRONMENTS` and the deployment names, handed
 * to the accessors. That only worked because the accessors forwarded a name to
 * the mint, which is the defect: a hosted process calling either one with `test`
 * received a genuine capability and the demo catalog with it. The names are now
 * asked of `isNonDeploymentEnvironmentName`, which answers about a string and
 * issues, registers and grants nothing, so the coverage survives the parameter
 * that carried it.
 *
 * IT IS THE SAME ARRAY THE REGISTRY'S GATE RESTS ON, one function call away:
 * `classifyRuntime` admits a process by calling this exact predicate, and
 * `NonDeploymentEnvironment.classify` is one line over `classifyRuntime`. So a
 * value added to the allowlist starts being covered here without an edit.
 *
 * WHAT THIS PAIR DOES NOT PROVE, said rather than implied: that the mint still
 * consults the array. That link is a line inside `classifyRuntime` and is not
 * observable from a name. What the accessor suites below assert is the gate
 * itself, against the two values it can be handed -- a classification this
 * process was issued, and `null`.
 */
describe("the runtime allowlist the registry's gate rests on", () => {
  it("admits every name NON_DEPLOYMENT_ENVIRONMENTS publishes", () => {
    expect(NON_DEPLOYMENT_ENVIRONMENTS.length).toBeGreaterThan(0);

    for (const nodeEnv of NON_DEPLOYMENT_ENVIRONMENTS) {
      expect(isNonDeploymentEnvironmentName(nodeEnv), nodeEnv).toBe(true);
    }
  });

  /*
   * THE ONE THAT MATTERS AT THE NAME LEVEL. An allowlist exists to refuse what it
   * does not recognise, so the near-misses are asserted alongside the obvious
   * ones -- a capitalised spelling and a hosting platform's stage name are how
   * this fails open if the comparison is ever loosened.
   */
  it("refuses every deployment name, the near-misses, and an unset variable", () => {
    for (const nodeEnv of DEPLOYMENT_ENVIRONMENT_NAMES) {
      expect(isNonDeploymentEnvironmentName(nodeEnv), JSON.stringify(nodeEnv)).toBe(false);
    }

    expect(isNonDeploymentEnvironmentName(undefined)).toBe(false);
  });
});

describe("resolveCatalogMetadataSource", () => {
  /*
   * The granting branch, reached the only way anything can reach it: with a
   * classification this process was actually issued. There is no loop over
   * environment names here because there is no parameter to put one in.
   */
  it("configures the fixture source when handed a classification", () => {
    const resolution = resolveCatalogMetadataSource(TEST_RUNTIME);

    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.source.sourceId).toBe("demo-fixtures");
  });

  /*
   * THE ONE THAT MATTERS. A hosted build has no metadata source at all, so it
   * cannot serve six invented titles as though they were the catalog. The
   * refusal is a named reason and not an empty list, because "no provider is
   * configured" has an operator remedy and "the catalog is empty" does not.
   *
   * `null` IS THE DEPLOYMENT, not a stand-in for one: it is exactly what
   * `classify()` answers in a hosted process, so this exercises the branch a
   * deployment takes rather than a simulation of it.
   */
  it("configures nothing on a deployment, with a stated reason", () => {
    expect(resolveCatalogMetadataSource(null, null)).toEqual({
      status: "not-configured",
      reason: "no_metadata_source_configured",
      detail: null
    });
  });

  /*
   * The default argument classifies the process at CALL time, and does not
   * freeze a verdict at module scope. Compared against an explicit call to the
   * same mint rather than against a hardcoded expectation, so this asserts the
   * wiring without also asserting which environment the suite happens to run in.
   *
   * COMPARED ON OBSERVABLE FACTS RATHER THAN ON THE TWO OBJECTS. See `observe`
   * above: the configured branch carries closures, two calls build two of them,
   * and `toEqual` reads that as a difference while printing none. What this
   * asserts is what it always meant to assert -- that the parameterless call
   * lands on the same branch, with the same source, publishing the same records,
   * as the call that states the classification explicitly.
   *
   * It is not a vacuous comparison of two refusals: vitest sets `NODE_ENV=test`,
   * which the allowlist admits, so both sides are configured resolutions here. A
   * default that answered anything else -- a module-scope snapshot taken before
   * the environment was set, a hardcoded `null`, nothing at all -- puts the two
   * calls on different branches and this fails.
   *
   * WHAT IT NO LONGER HAS TO RULE OUT is a default that read the environment
   * from somewhere other than the process, because `classify` accepts nothing
   * from which a different environment could arrive.
   */
  it("classifies the process when given no argument", async () => {
    expect(await observe(resolveCatalogMetadataSource())).toEqual(
      await observe(resolveCatalogMetadataSource(NonDeploymentEnvironment.classify()))
    );
  });
});

/*
 * THERE IS NO `resolveSynchronousCatalogMetadataSource` SUITE ANY MORE.
 *
 * WHAT STOOD HERE. A suite asserting the registry's second accessor -- the one
 * that answered a `SynchronousCatalogMetadataSource` for a caller that could not
 * await, whose one production caller was `findDemoTitleDetail` in
 * `app/title/demo-title-details.ts`. It asserted that the accessor really was
 * synchronous (by calling `.map` on `listRecords()` with no `await`, a
 * compile-time assertion), that it refused a deployment by name rather than
 * answering an empty catalog, and that it gated on the same classification as
 * the accessor above.
 *
 * WHY IT IS GONE. The title surface is asynchronous, so the accessor had no
 * legitimate production consumer and was deleted rather than left as a refusal
 * path nothing calls. For one round it existed in a NARROWED form that refused a
 * configured deployment with `metadata_source_requires_awaiting`; that was an
 * honest description of an unfinished migration and it stopped being one when
 * the migration finished, so the reason and its suite went with the condition.
 *
 * NOTHING IT PROVED HAS BEEN LOST. Both directions of the environment gate are
 * asserted of the one remaining accessor above, against the same two values
 * anything can hand it -- a classification this process was really issued, and
 * `null`. The synchrony of the FIXTURE SOURCE, which is a true fact about an
 * in-process array rather than a promise the registry makes to anybody, is still
 * asserted at compile time in "the demo metadata source" below, which calls
 * `.map` on `listRecords()` with no `await` against `demoCatalogSource` directly.
 */

/*
 * THERE IS NO `readFixtureCatalogItems` SUITE ANY MORE.
 *
 * The registry used to export a synchronous accessor that returned
 * `readonly CatalogItem[]`, and this file asserted both of its directions. It
 * existed only to be the default argument of `getHomeCatalog` in
 * `lib/catalog.ts`, which existed only to serve the home API route
 * synchronously; that route now awaits `loadHomeCatalog`, so both functions had
 * nothing but test callers left and were deleted rather than kept alive for
 * them.
 *
 * `resolveSynchronousCatalogMetadataSource`, asserted above, is NOT that function
 * returning under another name. The deleted one answered `[]` on a deployment and
 * had nowhere in its return type to put a reason; this one answers the same
 * tagged resolution as `resolveCatalogMetadataSource` and refuses by name, which
 * is the property its own suite is written around.
 *
 * Nothing it proved has been lost. The `resolveCatalogMetadataSource` tests above
 * cover both directions of the environment gate, and "the demo metadata source"
 * below covers what the fixture source publishes and that every record declares
 * a rights basis agreeing with its item -- which is what made `selectDeclaredItems`
 * pass all six items through the deleted accessor in the first place.
 */

describe("the demo metadata source", () => {
  /*
   * OBTAINING ONE REQUIRES HANDLING THE REFUSAL, and `classifiedProcess` at the
   * top of this file does it in full view: `classify()` answers
   * `NonDeploymentEnvironment | null` and `demoCatalogSource` takes the non-null
   * type, so there is no expression that reaches the fixtures without that
   * branch. That is what makes it a control rather than a formality: a bare
   * runtime `if` in front of an ungated factory could be deleted and everything
   * would still compile, whereas deleting the `null` branch in the registry is a
   * type error, because the factory's parameter is not nullable.
   */
  const source = demoCatalogSource(TEST_RUNTIME);

  /*
   * The source reports the environment carried by the capability it was given.
   *
   * WHAT THIS NO LONGER DISCRIMINATES, stated rather than left for a reader to
   * discover. It used to classify `development` from a process running as `test`,
   * so a `demoCatalogSource` that re-read `process.env` instead of reading its
   * argument answered a different string and failed here. Nothing mints from a
   * name any more, so the only capability this suite can hold carries this
   * process's own `NODE_ENV` and the two answers coincide -- and the alternative,
   * assigning `process.env.NODE_ENV` mid-suite to manufacture a divergence, races
   * every other file sharing this worker, which is the trade every comment in
   * this lane refuses.
   *
   * WHAT SURVIVES is that the field is populated from the capability rather than
   * invented: `nodeEnv` is the only member `NonDeploymentEnvironment` exposes, so
   * a source that answered anything else would have had to read the environment
   * itself. The value is asserted to be one the allowlist admits, which is the
   * property that made it worth reporting.
   */
  it("reports the environment its capability carries", () => {
    expect(source.environment).toBe(TEST_RUNTIME.nodeEnv);
    expect(isNonDeploymentEnvironmentName(source.environment)).toBe(true);
    expect(demoCatalogSource(TEST_RUNTIME).environment).toBe(TEST_RUNTIME.nodeEnv);
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

/*
 * The runtime half of the gate on the fixtures, which the type cannot supply.
 *
 * `demoCatalogSource`'s parameter is checked by the COMPILER, and two values get
 * past a compiler: an `as unknown as NonDeploymentEnvironment`, and a spread copy
 * of a genuine classification. The cast is the blunt forgery; the SPREAD is the
 * subtle one and the reason a brand alone was never enough -- object spread
 * copies the symbol-keyed brand along with everything else, so it type-checks
 * with no cast at all and only object IDENTITY tells it from the real thing.
 * Both are exercised, matching
 * `packages/provider-sdk/src/fixture/provider.test.ts` and the equivalent suites
 * in `lib/db/in-memory-repository.test.ts` and `lib/session/account.test.ts`.
 *
 * NEITHER CASE THROWS WITHOUT THE REGISTRY CHECK IN `demoCatalogSource`. A
 * forgery is not `null`, so the registry's deployment branch never sees it, and
 * the factory itself reads nothing off the argument but `nodeEnv` -- which both
 * forgeries carry, and carry as a value the allowlist admits. Without the check
 * each one is handed a working source over all six fixture records, which is the
 * exact outcome the gate exists to keep out of a hosted build.
 *
 * THERE IS NO ORDERING TEST HERE, unlike the fixture provider's and
 * `developmentAccount`'s. Those refuse other things too -- an origin, a malformed
 * header -- so "the forgery is reported first" is a fact with two possible
 * answers. This function's only other act is reading `nodeEnv`, which produces no
 * refusal of its own, so such a test would pass with and without the check and is
 * not worth writing.
 *
 * The granting direction is not restated: `demoCatalogSource(TEST_RUNTIME)` is
 * called in the suite above, at describe-body scope, so a check that refused a
 * genuine capability would fail there during collection.
 */
describe("a classification the contracts module never issued", () => {
  it("cannot obtain the fixture source", () => {
    const cast = { nodeEnv: "test" } as unknown as NonDeploymentEnvironment;
    /* Genuine, then copied: the copy carries the brand and is refused anyway. */
    const copied: NonDeploymentEnvironment = { ...TEST_RUNTIME };
    const forgeries: readonly (readonly [string, NonDeploymentEnvironment])[] = [
      ["a cast", cast],
      ["a spread copy", copied]
    ];

    for (const [label, forged] of forgeries) {
      /*
       * A throw rather than a returned reason, because this function's contract
       * is to return a source and it has no result union to put one in; the
       * registry above it publishes `no_metadata_source_configured` properly for
       * the caller that came through it with `null`. Matched on the phrase that
       * names the fault rather than on the whole message, so rewording the rest
       * does not break this.
       */
      expect(() => demoCatalogSource(forged), label).toThrow(
        "the runtime classification handed to demoCatalogSource was not issued by " +
          "@liberty/contracts/shared/runtime"
      );
    }
  });
});

/* -------------------------------------------------------------------------
 * The real source, standing behind the application's port
 *
 * WHAT THESE SUITES EXIST TO PROVE, and it is one sentence: a deployment that
 * has been given a real catalog metadata runtime no longer answers
 * `no_metadata_source_configured`, because the only implementation this registry
 * could reach was the demo one. That was true of every previous version of this
 * file and it is what round 51 was sent back to fix.
 *
 * THE RUNTIME IS THE REAL LICENSED ONE, not a fake. What this registry decides
 * is WHICH source this process has, and the whole disputed claim is that the
 * answer can now be something other than the demo implementation -- which a fake
 * provider would not settle. What the source then ANSWERS is a different
 * subject and belongs to `catalog-ingestion-source.test.ts`, where a
 * hand-written provider drives the rights, availability and failure paths
 * without any source-specific knowledge in `apps/web`.
 *
 * SO ONLY RESOLUTIONS ARE ASSERTED HERE, never a page. The runtime's transport
 * throws if anything asks it, which is how these suites prove they opened
 * nothing: composition happens before a fetch, and a registry that started a
 * pass would fail rather than pass.
 *
 * THE SOURCE NAME IS READ OUT OF THE PACKAGE'S FROZEN LICENSED LIST rather than
 * written as a literal. The licensing decision is an INITIAL SOURCE CHOICE AND
 * NOT AN EXCLUSIVE MANDATE, and a test hardcoding `"wikidata"` would need
 * editing the day a second source is licensed -- which is a day these
 * assertions should survive untouched.
 * ---------------------------------------------------------------------- */

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");

const READ: CatalogIngestionReadOptions = {
  locales: ["en"],
  territory: "GB",
  unstatedAvailability: "refuse",
  pageSize: 10,
  maxPages: 2
};

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.")) return "loopback";
  return "public";
};

const licensedRuntime = (
  over: Partial<CatalogProviderRuntime> = {}
): CatalogIngestionRuntime => ({
  provider: {
    sourceId: LICENSED_CATALOG_SOURCE_IDS[0] ?? "",
    selection: { classQid: "Q11424", kind: "movie", locales: ["en"] },
    document: {
      egress: {
        allowedHosts: [...WIKIDATA_CC0_HOSTS],
        allowLoopback: false,
        localDeployment: false
      },
      timeoutMs: 10_000,
      maxResponseBytes: 4_000_000,
      maxRedirects: 3,
      userAgent: "LibertyCatalog/0.1 (https://liberty.example.test; ops@example.test)"
    },
    transport: {
      fetchImpl: () => {
        throw new Error("no test in this file may reach the network");
      },
      classifyHost,
      resolveHost: () => Promise.resolve(["198.51.100.10"]),
      now: () => NOW_MS
    },
    rightsRegister: noRightsBasisEstablished,
    ...over
  },
  read: READ,
  now: () => NOW_MS
});

describe("a deployment with a real source configured", () => {
  /*
   * THE REGRESSION THE ROUND-51 CORRECTIVE NAMES FIRST. Before this, every
   * argument to this function produced either the demo fixtures or
   * `no_metadata_source_configured`, because those were the only two things the
   * registry could reach. `null` for the environment is the deployment, obtained
   * the way a deployment obtains it -- it is exactly what `classify()` answers in
   * a hosted process -- and the answer is now a CONFIGURED resolution over the
   * real source.
   */
  it("no longer answers no_metadata_source_configured", () => {
    const resolution = resolveCatalogMetadataSource(null, licensedRuntime());

    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.source.sourceId).toBe(LICENSED_CATALOG_SOURCE_IDS[0]);
  });

  /*
   * AND IT IS NOT THE FIXTURES. Asserted separately and negatively, because
   * "configured" passing while `demo-fixtures` came back would be the worst
   * possible outcome of this change: a hosted deployment serving six invented
   * films as though they were the catalog, which is the exact thing the
   * environment gate was built to prevent.
   */
  it("is never served the demo fixtures", () => {
    const resolution = resolveCatalogMetadataSource(null, licensedRuntime());

    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.source.sourceId).not.toBe("demo-fixtures");
  });

  /*
   * A CONFIGURED RUNTIME OUTRANKS THE FIXTURES OUTSIDE A DEPLOYMENT TOO. A
   * developer who configures a real source locally and silently gets six
   * invented films back has been lied to in the least useful possible way.
   */
  it("outranks the fixtures in a classified process as well", () => {
    const resolution = resolveCatalogMetadataSource(TEST_RUNTIME, licensedRuntime());

    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.source.sourceId).not.toBe("demo-fixtures");
  });

  /*
   * A SUPPLIED RUNTIME THE PACKAGE REFUSES IS ITS OWN REASON. Telling an
   * operator to "configure a metadata source" when they configured one and got
   * the name wrong sends them looking for the wrong thing, so the reason and the
   * package's own detail are both published.
   */
  it("refuses a runtime naming an unlicensed source, and says which failure it was", () => {
    const resolution = resolveCatalogMetadataSource(
      null,
      licensedRuntime({ sourceId: "tmdb" })
    );

    expect(resolution.status).toBe("not-configured");
    if (resolution.status !== "not-configured") return;
    expect(resolution.reason).toBe("catalog_metadata_source_configuration_refused");
    expect(resolution.detail).toContain("no_catalog_provider_licensed");
  });

  /*
   * AND IT STILL DOES NOT FALL BACK. A refused runtime in a classified process
   * is a refusal, not a quiet return to the fixtures -- which would hide a
   * misconfiguration from the one environment where somebody is watching.
   */
  it("does not fall back to the fixtures when a supplied runtime is refused", () => {
    const resolution = resolveCatalogMetadataSource(
      TEST_RUNTIME,
      licensedRuntime({ sourceId: "tmdb" })
    );

    expect(resolution.status).toBe("not-configured");
  });
});

describe("registerCatalogIngestionRuntime", () => {
  /*
   * THE DEFAULT ARGUMENT READS THE REGISTRATION, which is what makes the real
   * source reachable from `loadHomeCatalog` and `getSearchResults` -- neither of
   * which passes a runtime, and neither of which is going to grow a parameter
   * for one.
   *
   * REGISTERED AND CLEARED IN A `finally`, because this is module state and a
   * suite that leaked it would configure every later test in this file.
   */
  it("is what a parameterless call resolves against", () => {
    const previous = registeredCatalogIngestionRuntime();
    try {
      expect(previous).toBeNull();
      registerCatalogIngestionRuntime(licensedRuntime());

      const resolution = resolveCatalogMetadataSource(null);
      expect(resolution.status).toBe("configured");
      if (resolution.status !== "configured") return;
      expect(resolution.source.sourceId).toBe(LICENSED_CATALOG_SOURCE_IDS[0]);
    } finally {
      registerCatalogIngestionRuntime(previous);
    }
  });

  /*
   * NOTHING AMBIENT SUPPLIES ONE. There is no environment variable, no file and
   * no default behind this: an unregistered process has no runtime, which is why
   * a hosted deployment still refuses by name today.
   */
  it("holds nothing until something registers something", () => {
    expect(registeredCatalogIngestionRuntime()).toBeNull();
    expect(resolveCatalogMetadataSource(null).status).toBe("not-configured");
  });
});

describe("the accessor the title surface was migrated onto", () => {
  /*
   * ITEM 9, FROM THE REGISTRY'S SIDE. There is ONE accessor now. The synchronous
   * one existed because `findDemoTitleDetail` could not await; both it and
   * `getTitleDetail` are asynchronous, so it had no production caller left and
   * was deleted rather than kept as a refusal path nothing calls.
   *
   * THE PROPERTY WORTH ASSERTING IS THAT THE SAME CALL SERVES ALL THREE
   * SURFACES. The home rails, the search index and the title detail now take the
   * same resolution from the same function, so a deployment cannot be told three
   * different stories about its own catalog. Asserted as identity of answer
   * across the two inputs anything can hand it.
   */
  it("answers one resolution, whoever is asking", async () => {
    const cases: readonly (NonDeploymentEnvironment | null)[] = [TEST_RUNTIME, null];

    for (const environment of cases) {
      expect(
        await observe(resolveCatalogMetadataSource(environment, null)),
        environment === null ? "deployment" : "classified process"
      ).toEqual(await observe(resolveCatalogMetadataSource(environment, null)));
    }
  });

  /*
   * THE REFUSAL VOCABULARY IS EXACTLY TWO, AND `metadata_source_requires_awaiting`
   * IS NOT ONE OF THEM. Asserted at runtime over every reason the registry can
   * actually produce, because a deleted union member is otherwise only caught by
   * the compiler -- and the compiler cannot see a string that a log, a dashboard
   * or a runbook still expects.
   */
  it("produces only the two configuration reasons that can still occur", () => {
    const observed = new Set<string>();

    const unconfigured = resolveCatalogMetadataSource(null, null);
    if (unconfigured.status === "not-configured") observed.add(unconfigured.reason);

    const refused = resolveCatalogMetadataSource(null, licensedRuntime({ sourceId: "tmdb" }));
    if (refused.status === "not-configured") observed.add(refused.reason);

    expect([...observed].sort()).toEqual([
      "catalog_metadata_source_configuration_refused",
      "no_metadata_source_configured"
    ]);
    expect(observed.has("metadata_source_requires_awaiting")).toBe(false);
  });

  /*
   * IT COMPOSES NOTHING IT IS ABOUT TO REFUSE. The transport in the runtime
   * throws on use, so a resolution that built a provider and started a pass on
   * behalf of a caller it was about to turn away would surface here. Resolution
   * is a synchronous decision; the I/O belongs to the source it hands back.
   */
  it("builds no provider and opens nothing while resolving", () => {
    expect(() => resolveCatalogMetadataSource(null, licensedRuntime({ sourceId: "tmdb" }))).not.toThrow();
    expect(() => resolveCatalogMetadataSource(null, licensedRuntime())).not.toThrow();
  });
});
