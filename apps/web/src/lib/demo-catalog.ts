import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { NonDeploymentEnvironment } from "../app/api/deployment-environment";
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
 * opened. The remedy there is the remedy here: the fixtures are not withheld
 * from a deployment, they are UNCONSTRUCTIBLE in one.
 *
 * `NonDeploymentEnvironment` is imported rather than restated. It cannot be
 * built outside `app/api/deployment-environment.ts` (private constructor, plus a
 * private field so TypeScript compares it nominally), and the only way to obtain
 * one is `classify`, which answers `null` for every environment outside its
 * allowlist. So `demoCatalogSource` cannot be reached without handling that
 * `null`, and deleting the check is a compile error rather than a silent
 * widening. That module notes its eventual home is `apps/web/src/lib/`; this
 * import is one more caller waiting for the move.
 * ---------------------------------------------------------------------- */

/**
 * The basis every fixture record carries.
 *
 * Declared once so an edit cannot make one fixture quietly more permissive than
 * its siblings, and `reference: null` because these works have no entry in any
 * rights register. `authorized-candidates.ts` faced the same question with a
 * non-nullable field and answered it with a reserved all-zero token; here the
 * field is nullable, so the truthful answer is available and is used.
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
 * The argument is the whole control, and it is a value rather than a condition
 * for the reason `fixtureProvider` gives at length: a runtime `if` can be
 * deleted and everything still compiles, which is how a second, ungated copy of
 * the playback fixtures came to ship. A caller here cannot construct the witness
 * and cannot reach this function without one.
 *
 * What it does not defend against is an edit to this file or to
 * `deployment-environment.ts`. Nothing in TypeScript can. What it defends
 * against is the way the defect actually recurs: a change somewhere else that
 * quietly stops consulting the gate.
 *
 * The same remaining gap applies as everywhere else this witness is used: a
 * hosted deployment that exports `NODE_ENV=development` and runs `next dev` is
 * indistinguishable from a laptop here, because it IS a development build.
 */
export function demoCatalogSource(
  environment: NonDeploymentEnvironment
): DemoCatalogMetadataSource {
  return {
    sourceId: "demo-fixtures",
    environment: environment.nodeEnv,
    listRecords: () => DEMO_RECORDS,
    findRecord: (contentId) =>
      DEMO_RECORDS.find((record) => record.item.id === contentId) ?? null
  };
}
