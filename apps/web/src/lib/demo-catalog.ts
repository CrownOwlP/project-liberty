import type { CatalogItem } from "@liberty/contracts/domains/catalog";
/*
 * BOTH COME THROUGH `app/api/deployment-environment.ts`, this app's door onto
 * `@liberty/contracts/shared/runtime`. That door names the CAPABILITY and
 * re-exports the registry check beside it, alongside the allowlist and the name
 * predicate, so this file reaches one module by one route instead of two. The
 * check is not restated by the re-export -- a re-export creates no local binding
 * and adds no hop -- so this is the same function `createFixtureProvider` and
 * `localDeploymentFor` call.
 */
import {
  isClassifiedRuntime,
  type NonDeploymentEnvironment
} from "../app/api/deployment-environment";
import type {
  CatalogMetadataRecord,
  CatalogRightsBasis,
  SynchronousCatalogMetadataSource
} from "./catalog-source";

/* -------------------------------------------------------------------------
 * The development metadata fixtures, and the gate in front of them
 *
 * These are fictional works written for this project. No third-party catalog
 * metadata is reproduced here, so the `owned` category below is a true statement
 * rather than an assumed one -- and the register reference is `null`, because
 * there is no agreement anywhere for a reference to name.
 *
 * WHY A GATE AT ALL, WHEN THE RIGHTS CLAIM IS TRUE. Because the claim the
 * deployment would be making is not "these six works are owned", it is "this is
 * the catalog". Six invented titles served from a hosted build are presented to
 * a reader as the product's content, and every downstream surface -- the rails,
 * the search index, the title pages, the share previews -- states them as fact.
 * That is the discovery-layer version of the defect PL-0703 removed from the
 * playback path, where a fixture provider declared `owned` over media nobody had
 * opened. The remedy there is the remedy here, and what it establishes is a
 * statement about what a CALLER can reach along this path rather than a claim
 * that the fixture source cannot be built at all: the gate is not a runtime `if`
 * a later edit can drop, because the only mint answers `null` in a hosted
 * process, every parameter on the path is typed to take that capability or
 * `null` so no argument can introduce some other answer, and
 * `demoCatalogSource`'s own parameter is non-nullable, which makes deleting the
 * registry's `null` branch a compile error rather than a silent widening.
 *
 * AND THE TYPE IS NO LONGER TAKEN ON TRUST. `demoCatalogSource` consults
 * `isClassifiedRuntime` as its first action, so the two forgeries a compile-time
 * brand cannot stop -- an `as unknown as NonDeploymentEnvironment`, and a spread
 * copy of a real classification, which carries the brand and needs no cast at
 * all -- are refused at runtime instead of yielding the fixtures. An earlier
 * version of this header recorded both as getting past this function, which was
 * true then and is the gap the check closed. It is the ordering
 * `createFixtureProvider` uses in
 * `@liberty/provider-sdk`: ask the registry before reading any other field off
 * any argument.
 *
 * WHAT IT STILL DOES NOT BIND is an edit to any of the three files named further
 * down, or code inside the deployment that rewrites its own `NODE_ENV` before
 * the mint reads it -- a statement executing in the deployment, with the same
 * reach as an edit and the same visibility in a diff.
 * `docs/CATALOG_SOURCE.md` states this boundary as a list, and its entry for
 * this function now records that it consults the registry as its first action
 * and throws, which is what the code below does. If the two ever disagree, this
 * file is the one that can be checked against the code beside it.
 *
 * `NonDeploymentEnvironment` is imported rather than restated. It is the
 * capability `@liberty/contracts/shared/runtime` issues, and it cannot be built
 * anywhere else: the brand key is a `unique symbol` that module keeps to itself,
 * so no consumer can name the property and none can write it. The only producer
 * is `classifyRuntime`, which answers `null` for every environment outside the
 * one allowlist. So `demoCatalogSource` cannot be reached without handling that
 * `null`, and deleting the check is a compile error rather than a silent
 * widening. `app/api/deployment-environment.ts` is the app-side name for the
 * same capability, and it notes its eventual home is `apps/web/src/lib/`; this
 * import is one more caller waiting for the move.
 * ---------------------------------------------------------------------- */

/**
 * The basis every fixture record carries.
 *
 * Declared once so an edit cannot make one fixture quietly more permissive than
 * its siblings, and `reference: null` because these works have no entry in any
 * rights register. The playback side faced the same question with a NON-nullable
 * field and answered it with a reserved all-zero token -- but that token is no
 * longer minted in `apps/web`. It is `FIXTURE_RIGHTS_REFERENCE` in
 * `@liberty/provider-sdk`'s `fixture/rights.ts`, which is the one place the
 * opaque-reference rule is stated; `authorized-candidates.ts` forwards the SDK
 * provider's `rightsBasis` unchanged rather than declaring one. Here the field is
 * nullable, so the truthful answer is available and is used.
 */
const DEMO_RIGHTS_BASIS: CatalogRightsBasis = {
  category: "owned",
  reference: null
};

/**
 * The fixtures, as source records.
 *
 * THIS IS THE ONE DECLARATION. `demoCatalog` below is derived from it rather
 * than written beside it: two hand-maintained lists of the same six works is how
 * the rails and the source eventually disagree about what exists, and nothing
 * would catch it.
 */
const DEMO_RECORDS: readonly CatalogMetadataRecord[] = [
  {
    item: {
      id: "aurora-fall",
      title: "Aurora Fall",
      kind: "movie",
      rights: "owned",
      genre: "Sci-fi",
      releaseYear: 2024,
      runtimeMinutes: 128,
      episodeCount: null
    },
    rights: DEMO_RIGHTS_BASIS
  },
  {
    item: {
      id: "signal-zero",
      title: "Signal Zero",
      kind: "movie",
      rights: "owned",
      genre: "Thriller",
      releaseYear: 2023,
      runtimeMinutes: 114,
      episodeCount: null
    },
    rights: DEMO_RIGHTS_BASIS
  },
  {
    item: {
      id: "deep-current",
      title: "Deep Current",
      kind: "movie",
      rights: "owned",
      genre: "Documentary",
      releaseYear: 2025,
      runtimeMinutes: 52,
      episodeCount: null
    },
    rights: DEMO_RIGHTS_BASIS
  },
  {
    item: {
      id: "northstar",
      title: "Northstar",
      kind: "series",
      rights: "owned",
      genre: "Drama",
      releaseYear: 2024,
      runtimeMinutes: null,
      episodeCount: 8
    },
    rights: DEMO_RIGHTS_BASIS
  },
  {
    item: {
      id: "open-skies",
      title: "Open Skies",
      kind: "movie",
      rights: "owned",
      genre: "Adventure",
      releaseYear: 2022,
      runtimeMinutes: 107,
      episodeCount: null
    },
    rights: DEMO_RIGHTS_BASIS
  },
  {
    item: {
      id: "harbor-lights",
      title: "Harbor Lights",
      kind: "series",
      rights: "owned",
      genre: "Mystery",
      releaseYear: 2025,
      runtimeMinutes: null,
      episodeCount: 6
    },
    rights: DEMO_RIGHTS_BASIS
  }
];

/**
 * The fixture items, ungated.
 *
 * NO SHIPPED MODULE IMPORTS IT ANY MORE. The home rails, the search index and
 * the title detail surface all reach the fixtures through `demoCatalogSource`
 * below, which cannot be called without a `NonDeploymentEnvironment`, so the
 * gate above is no longer bypassed by anything a deployment runs. This comment
 * used to name `app/search/search.ts` and `app/title/demo-title-details.ts` as
 * direct importers; both have been migrated.
 *
 * WHAT STILL READS IT IS FOUR TEST FILES, and that is why the export survives:
 *
 *   - `lib/catalog.test.ts` -- the surfaced set equals the eligible fixture set;
 *   - `lib/routes.test.ts` -- every fixture that reaches a home rail is routable,
 *     and every fixture gets a distinct address;
 *   - `lib/catalog-source-registry.test.ts` -- the source publishes exactly these
 *     items, in this order;
 *   - `app/title/title-detail.test.ts` -- every browsable fixture resolves to a
 *     contract-valid title detail.
 *
 * Each of those needs a name for the fixture set that is not the thing under
 * test. `lib/catalog-source-registry.test.ts` makes the reason plainest: a test
 * that obtained the set from `demoCatalogSource` and then compared it against
 * `demoCatalogSource` would be comparing a value with itself. Reconstructing the
 * array in four suites instead -- classify, construct the source, map records to
 * items -- would put four hand-maintained copies of one list in the repository,
 * which is the drift `DEMO_RECORDS` exists to prevent.
 *
 * WHAT THE EXPORT COSTS, stated rather than declared harmless. It is an ungated
 * array in a module a deployment does compile, so a future production import of
 * it would walk past the witness without a compile error. The gate holds today
 * because nothing does; it is not the gate that would stop the next module from
 * trying. `docs/CATALOG_SOURCE.md` records this as the one remaining seam in an
 * otherwise total control.
 *
 * Derived from `DEMO_RECORDS` so the two cannot drift. The item order is
 * unchanged from when this array was written by hand -- `e2e/src/fixtures.ts`
 * names these ids, and `buildHomeCatalog` sorts anyway, but an id disappearing
 * from here is an E2E failure with a confusing message.
 */
export const demoCatalog: readonly CatalogItem[] = DEMO_RECORDS.map((record) => record.item);

/**
 * A fixture source, reporting which environment admitted it.
 *
 * `environment` mirrors `FixtureProvider` in
 * `app/api/v1/playback/session/authorized-candidates.ts`: it is the value the
 * classification actually used, so a caller that logs or asserts WHICH
 * environment authorised the fixtures does not re-read `process.env` and risk
 * reporting a different answer.
 */
export interface DemoCatalogMetadataSource extends SynchronousCatalogMetadataSource {
  readonly environment: string;
}

/**
 * The fixture metadata source, obtainable only with proof that this process is
 * not a deployment.
 *
 * THE CONTROL IS THE ARGUMENT PLUS THE QUESTION ASKED OF IT, and both halves are
 * needed. The argument is a value rather than a condition for the reason
 * `fixtureProvider` gives at length: a runtime `if` can be deleted and
 * everything still compiles, which is how a second, ungated copy of the playback
 * fixtures came to ship. But a parameter typed `NonDeploymentEnvironment` is
 * only the COMPILE-TIME half -- a cast and a spread copy both type-check -- so
 * the runtime half is the identity check below, which asks the registry whether
 * the contracts module issued this exact object.
 *
 * What it does not defend against is an edit to this file, to
 * `deployment-environment.ts`, or to `@liberty/contracts/shared/runtime` where
 * the capability is minted. Nothing in TypeScript can. What it defends against
 * is the way the defect actually recurs: a change somewhere else that quietly
 * stops consulting the gate, or a caller that manufactures the value the gate
 * asks for.
 *
 * The same remaining gap applies as everywhere else this witness is used: a
 * hosted deployment that exports `NODE_ENV=development` and runs `next dev` is
 * indistinguishable from a laptop here, because it IS a development build.
 *
 * WHY THE REFUSAL IS A THROW, in a repository where a refusal is normally a
 * returned reason. This function's contract is to return a source; it has no
 * result union to put a reason in, and it cannot grow one without editing the
 * one module that calls it outside a test. That caller is
 * `lib/catalog-source-registry.ts`, which owns the
 * `not-configured` / `no_metadata_source_configured` vocabulary and is outside
 * this lane's paths. The three alternatives are all worse: returning `null` does
 * not compile at that call site; answering a source over an empty record list is
 * the collapse of "refused" into "empty" that the registry header and the
 * deleted `readFixtureCatalogItems` are both arguments against; and leaving the
 * check out is the gap this edit exists to close. A throw on this chain is not
 * novel either -- `CatalogMetadataSourceNotConfiguredError` in
 * `app/title/demo-title-details.ts` is one, and `fixtureRightsBasis` in the SDK
 * throws for the same class of condition: one only an edit or a forgery reaches.
 *
 * IT IS AN `Error` AND NOT A NAMED SUBCLASS, unlike that one, because nothing
 * branches on it. `title-detail.ts` tests for its class with `instanceof` and so
 * needs one; every caller of this function either holds a genuine capability or
 * is a defect. If something ever has to tell this failure from another, the
 * upgrade is the class-with-a-`reason`-field pattern in `demo-title-details.ts`,
 * not a comparison against the message text below.
 */
export function demoCatalogSource(
  environment: NonDeploymentEnvironment
): DemoCatalogMetadataSource {
  /*
   * THE FIRST THING THIS FUNCTION DOES, before it reads `nodeEnv` or anything
   * else off the argument. The ordering is the one `createFixtureProvider`
   * documents and is not incidental: a forged capability must be reported as a
   * forgery rather than half-consumed first.
   */
  if (!isClassifiedRuntime(environment)) {
    throw new Error(
      "the runtime classification handed to demoCatalogSource was not issued by " +
        "@liberty/contracts/shared/runtime, so nothing has shown this process is not a " +
        "deployment; these fixtures are an invented catalog and a cast or a spread copy " +
        "carries the capability's brand but not the decision behind it"
    );
  }

  return {
    sourceId: "demo-fixtures",
    environment: environment.nodeEnv,
    listRecords: () => DEMO_RECORDS,
    findRecord: (contentId) =>
      DEMO_RECORDS.find((record) => record.item.id === contentId) ?? null
  };
}
