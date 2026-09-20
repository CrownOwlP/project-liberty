import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { ContentRights } from "@liberty/contracts/shared/rights";

/* -------------------------------------------------------------------------
 * Where catalog metadata comes from
 *
 * THE GAP THIS CLOSES IS A SEAM, NOT A SOURCE. `docs/PRODUCT_SPEC.md` step 2 is
 * "browse/search normalized metadata", and nothing in this repository ingests
 * metadata. Every discovery surface is backed by `lib/demo-catalog.ts`, a
 * hardcoded array of six fictional works, and each one USED TO IMPORT that array
 * directly -- so the day a real metadata provider arrived, the edit was not
 * "configure a source", it was "find every import of the fixture array and
 * rewrite the surface around it". PL-0301 and PL-0302 do not close this: they supply STREAM
 * CANDIDATES, which is what a title plays from, not what a catalog is made of.
 *
 * EVERY DISCOVERY SURFACE NOW READS THROUGH THIS PORT, and none of them names an
 * implementation any more. All three reach it through ONE accessor,
 * `resolveCatalogMetadataSource` in `lib/catalog-source-registry.ts`: the home
 * rails via `loadHomeCatalog` in `lib/catalog.ts`, `app/search/search.ts`, and
 * `app/title/demo-title-details.ts`. The title surface used to need a second,
 * synchronous accessor because it could not await; it is asynchronous as of
 * round 51 and that accessor is deleted. `lib/demo-catalog.ts` still exports the
 * raw `demoCatalog` array, but its only remaining readers are test files, so the
 * environment gate in front of the fixtures is no longer bypassable from shipped
 * code.
 *
 * This module is the interface such a provider would implement. It does not
 * implement one. There is no ingestion here, no refresh, no dedupe and no
 * network; see `docs/CATALOG_SOURCE.md` for the list of what is deliberately
 * unanswered.
 *
 * THOSE FOUR NOW EXIST -- IN A PACKAGE, NOT HERE, AND WITH A REAL SOURCE BEHIND
 * THEM. PL-0305 built `@liberty/catalog-ingestion`: identity and dedupe, an
 * `observedAt` with a staleness policy over it, tombstones that only a complete
 * pass can mint, cursor paging, and a transport that is PL-0304's egress
 * boundary rather than a second one. PL-0305r put a WIKIDATA provider behind its
 * `CatalogMetadataProvider` port, on a human-commander Licensing decision dated
 * 2026-09-17.
 *
 * AND `apps/web` NOW DEPENDS ON THAT PACKAGE. The paragraph here used to say it
 * could not: the manifest edit was outside PL-0305's `allowedPaths`, so the port
 * could carry nothing the package expressed. `apps/web/package.json` declares
 * the dependency as of round 51, and `lib/catalog-ingestion-source.ts` is the
 * ONE module that consumes it -- through the package's root entry point, naming
 * no Wikidata module and no Wikidata type.
 *
 * THE PORT IS STILL ALMOST UNCHANGED, AND THE RESTRAINT IS STILL DELIBERATE. A
 * record here carries no age and there is still no way to say a work was
 * withdrawn, because expressing either means importing the package's vocabulary
 * into the module graph of every surface that renders a card, and a second
 * spelling of a freshness or tombstone rule inside `apps/web` is exactly the
 * drift this file argues against elsewhere. ONE thing was added:
 * `describeCatalog`, optional, below -- and it adds no vocabulary either, its
 * withheld reasons being plain strings that nothing in this application
 * branches on.
 *
 * IT IS EXPRESSED IN THE PUBLISHED CONTRACTS AND ADDS NO VOCABULARY OF ITS OWN.
 * The work is a `CatalogItem` from `@liberty/contracts/domains/catalog` and the
 * rights category is `ContentRights` from `@liberty/contracts/shared/rights`. A
 * port that invented its own item shape would be a second catalog vocabulary
 * free to drift from the one the rails, the search results and the API route
 * already agree on.
 * ---------------------------------------------------------------------- */

/**
 * What a source states about its right to describe a work.
 *
 * TWO FIELDS AND NO MORE, and the second one is opaque on purpose. The CATEGORY
 * is the part the platform enforces -- `isSurfaceable` in `lib/catalog.ts` gates
 * on exactly this vocabulary -- and the REFERENCE names a record in the
 * operator's own rights register. It means nothing to anyone who does not hold
 * that register, which is the point: the agreements themselves are not this
 * repository's to carry, so no counterparty, scope, term date, licence body or
 * URL may be written into one.
 *
 * NOTHING IN THIS APPLICATION PARSES OR BRANCHES ON `reference`. It is carried
 * and it is compared for presence; no code splits it, reads a prefix out of it,
 * or decides anything from its content. An identifier that gets interpreted has
 * stopped being an identifier, and the interpretation becomes a rights decision
 * taken by a string parser.
 *
 * WHAT IS NOT CHECKED HERE, stated rather than implied. THE SHAPE OF A CATALOG
 * RIGHTS REFERENCE IS UNENFORCED. A shape test exists -- `isOpaqueRightsReference`
 * over `OPAQUE_RIGHTS_REFERENCE_PATTERN` and `MAX_RIGHTS_REFERENCE_LENGTH`, which
 * mechanically excludes whitespace, prose, URLs and addresses -- and this module
 * neither applies it nor restates it.
 *
 * WHERE IT LIVES: `@liberty/provider-sdk`, exported from that package's root.
 * The export is the stable address; the file behind it, as of this edit, is
 * `packages/provider-sdk/src/fixture/rights.ts`. It is a leaf: that file is where
 * the rule is written, its own comment says so, and the second copy that used to
 * sit in `app/api/v1/playback/session/authorized-candidates.ts` is gone -- that
 * module now consumes the SDK and states no pattern of its own. An older version
 * of this comment named `authorized-candidates.ts` as the owner and named "move the
 * predicate to a leaf module" as the fix. Both statements have expired: the move
 * has happened, and what is left is the smaller question below.
 *
 * WHY THE PORT STILL DOES NOT APPLY IT, which is a smaller reason than the one it
 * replaces. `@liberty/provider-sdk` publishes a single entry point -- its
 * `package.json` sets `"exports": "./src/index.ts"` and no subpaths -- so
 * importing the predicate imports that root index, and with it the fixture
 * provider, the health scoring and the Stremio source vocabulary, into the module
 * graph of every surface that renders a card. That is a real cost for one regular
 * expression, and it is smaller than the cost this comment used to claim: the SDK
 * depends on `@liberty/contracts` and `zod` and nothing else, so no version of
 * this import pulls `@liberty/media-engine` anywhere. A subpath export would
 * remove the objection entirely; that is an edit to a package manifest, outside
 * this surface.
 *
 * AND IT WOULD BE A BEHAVIOUR CHANGE RATHER THAN A TIDY-UP. Enforcing the rule
 * here means records start being refused for the shape of an identifier nothing
 * reads, which needs a third `CatalogRecordRefusalReason` and a rights review to
 * decide whether an unparseable reference should withhold a work from browse at
 * all. Restating the pattern in this file remains refused outright: a second
 * spelling of a rights rule is the defect the SDK's own comment exists to
 * prevent. `docs/CATALOG_SOURCE.md` carries this as an open item.
 */
export interface CatalogRightsBasis {
  /** The enforced part. One of the shared rights vocabulary's three values. */
  readonly category: ContentRights;
  /**
   * An opaque internal register identifier, or `null` when the operator has no
   * record to point at.
   *
   * `null` is a real answer and not a hole: the demo fixtures are original works
   * authored inside this repository, so there is no agreement anywhere for a
   * reference to name, and a token pointing at a record that does not exist
   * would be a fabrication in a smaller font.
   */
  readonly reference: string | null;
}

/**
 * One work, as a metadata source states it.
 *
 * `rights` IS NULLABLE AND `item.rights` IS NOT, AND THAT IS THE WHOLE POINT OF
 * SPLITTING THEM. `catalogItemSchema` requires `rights` to be one of three
 * values, so the published catalog shape has no way to say "nobody has declared
 * a basis for this work" -- unlike `titleRightsBasisSchema`, which has exactly
 * that `null`. A source that knows of a work but not its rights therefore cannot
 * express itself through `CatalogItem` alone, and the direction that fails safe
 * is to make the BASIS the nullable thing and treat `item.rights` as the browse
 * shape's copy of the category rather than as evidence of anything.
 *
 * Consequently `rights: null` means the source declared no basis. It does NOT
 * mean the work is unrightsed, and it is never defaulted to a permissive value:
 * `selectDeclaredItems` refuses such a record outright. Widening
 * `catalogItemSchema` to carry a nullable basis is the deeper fix and is a
 * contract change, which is a package edit and a review; it is named in
 * `docs/CATALOG_SOURCE.md` rather than smuggled in from here.
 */
export interface CatalogMetadataRecord {
  readonly item: CatalogItem;
  /** `null` = the source declared no basis. Never read as permission. */
  readonly rights: CatalogRightsBasis | null;
}

/**
 * A metadata source: the interface a real provider implements.
 *
 * `listRecords` and `findRecord` are the two questions every discovery surface
 * in this app actually asks today -- the home rails and search enumerate, the
 * title detail resolves one id -- so the port is those two and nothing
 * speculative. A provider-side SEARCH capability is deliberately absent; see
 * `docs/CATALOG_SOURCE.md` for why in-process filtering is a real limit rather
 * than an oversight.
 *
 * BOTH MAY ANSWER SYNCHRONOUSLY OR WITH A PROMISE, which is the convention
 * `CatalogSource`, `TitleDetailSource` and `AuthorizedCandidateResolver` already
 * use in this app: an in-process fixture answers immediately and a
 * network-backed provider does not, and a port that demanded one of those would
 * exclude the other.
 *
 * `findRecord` answers `null` for an id the source does not know, and THROWS
 * when it cannot answer at all. That is the same split `TitleDetailSource`
 * documents, and it is what keeps "does not exist" distinguishable from "could
 * not be reached" instead of both arriving as an empty-looking payload.
 */
export interface CatalogMetadataSource {
  /**
   * Which source answered. Reported in diagnostics; nothing branches on it.
   *
   * Present because a deployment with more than one source configured otherwise
   * gives whoever is debugging a wrong rail no way to tell which provider
   * supplied the row.
   */
  readonly sourceId: string;
  listRecords(): readonly CatalogMetadataRecord[] | Promise<readonly CatalogMetadataRecord[]>;
  findRecord(
    contentId: string
  ): CatalogMetadataRecord | null | Promise<CatalogMetadataRecord | null>;
  /**
   * The same answer, plus why it is as short as it is.
   *
   * WHY THIS EXISTS AT ALL. `listRecords()` answers `[]` for two completely
   * different facts -- "this source listed works and not one of them may be
   * surfaced" and "this source listed nothing" -- and those have opposite
   * remedies. The first is an operator's rights register or availability data;
   * the second has no remedy because nothing is wrong. Handing a caller `[]`
   * for both is the collapse `CatalogLoadResult` and this whole port were built
   * to stop, one level further in.
   *
   * OPTIONAL, AND THAT IS NOT A HEDGE. It is optional for the same reason
   * `searchWorks` is optional on `CatalogMetadataProvider`: the in-process
   * fixture source has no pass behind it, refuses nothing, and could only
   * answer this by inventing one of the two states. A source that cannot tell
   * them apart says so by not implementing the method, and
   * `requireCatalogDescription` in `lib/catalog-ingestion-source.ts` is the
   * guard -- returning the method rather than a boolean, so a caller that got
   * past the check holds something callable.
   *
   * IT DOES NOT REPLACE THE THROW. A source that could not answer at all still
   * THROWS from this method exactly as it does from the other two. Three states
   * are reachable through this method and the fourth -- no source configured --
   * is answered by the registry before a source exists to ask.
   */
  describeCatalog?(): CatalogAnswer | Promise<CatalogAnswer>;
}

/**
 * What an answer is, beyond the records in it.
 *
 * `records_available` -- at least one record survived.
 * `no_records_usable` -- the source listed records and every one was withheld.
 * `catalog_empty` -- the source listed nothing. Not a failure and not a rights
 * problem: there was nothing there.
 */
export type CatalogAnswerState = "records_available" | "no_records_usable" | "catalog_empty";

/**
 * One record the source listed and the answer does not carry.
 *
 * `reason` IS A PLAIN STRING AND THIS PORT DEFINES NO VOCABULARY FOR IT, which
 * is the same restraint the rest of this file keeps. The reasons a real source
 * produces are `@liberty/catalog-ingestion`'s own -- `rights_basis_not_declared`,
 * `availability_not_stated`, `not_available_in_territory` and the rest -- and
 * they are carried through unchanged rather than translated, because an operator
 * debugging an empty rail needs the string the code actually produced. Nothing
 * in this application branches on one; a union here would be a second copy of
 * the package's vocabulary to keep in agreement with the first.
 */
export interface CatalogRecordWithheld {
  /** The provider's own id, or the derived content id, whichever the source had. */
  readonly recordId: string;
  readonly reason: string;
}

export interface CatalogAnswer {
  readonly state: CatalogAnswerState;
  readonly records: readonly CatalogMetadataRecord[];
  readonly withheld: readonly CatalogRecordWithheld[];
  /** When the source read what it is reporting. */
  readonly observedAt: string;
  /**
   * Whether the source was read in full.
   *
   * `false` means a bound stopped the read, so the absences in this answer are
   * absences from a prefix of the source and `catalog_empty` is not reachable.
   */
  readonly complete: boolean;
}

/**
 * A source that answers without awaiting.
 *
 * Narrower than the port and assignable to it. `DemoCatalogMetadataSource` in
 * `lib/demo-catalog.ts` is the one implementation and the registry is the only
 * module that names it.
 *
 * THE PREDICTION THIS INTERFACE CARRIED HAS NOW COME TRUE, and the shape of the
 * thing it predicted is worth recording rather than deleting. A real provider
 * does I/O and is therefore NOT assignable to this interface, so the day one
 * landed the compile error was in the registry -- the file whose job is
 * composing sources -- instead of the title surface quietly keeping a private
 * route to the fixtures, which is what it had before the narrowing existed.
 *
 * WHAT THE REGISTRY DID WITH THAT ERROR: it deleted the accessor. The title
 * surface became asynchronous, `resolveSynchronousCatalogMetadataSource` lost
 * its only production caller, and a refusal path with no caller is dead code
 * wearing a safety label. Nothing was buffered to satisfy this type and nothing
 * returned fixtures to a deployment to satisfy it either.
 *
 * SO WHY DOES THE INTERFACE SURVIVE THE ACCESSOR? Because it is a TRUE
 * STATEMENT ABOUT AN IMPLEMENTATION, which is a different thing from a promise
 * made to a caller. `DemoCatalogMetadataSource` in `lib/demo-catalog.ts` extends
 * it, and an in-process fixture array really does answer without awaiting; a
 * test that calls `.map` on `listRecords()` with no `await` is checking that
 * fact at compile time. What was removed is the RESOLUTION that handed one of
 * these to a caller who could not cope with anything else.
 *
 * THE HOME ROUTE IS NO LONGER ONE OF ITS CALLERS, and the comment here used to
 * name it as the only one. `app/api/v1/catalog/home/route.ts` called a
 * synchronous `getHomeCatalog`, which has been deleted along with
 * `readFixtureCatalogItems`, the synchronous fixture accessor it defaulted to.
 * The route awaits `loadHomeCatalog` instead, so nothing on the home path needs
 * this narrowing.
 *
 * AN IN-PROCESS FIXTURE SATISFIES THIS AND A REAL PROVIDER DOES NOT, because a
 * provider does I/O. That asymmetry was exactly why the title surface had to
 * become asynchronous before a real source could stand behind it, and
 * `docs/CATALOG_SOURCE.md` recorded the migration as outstanding for several
 * rounds. It is done. Nothing in this repository now takes this type as the
 * shape of a source it was HANDED; it is only ever the shape a fixture
 * implementation DECLARES.
 */
export interface SynchronousCatalogMetadataSource extends CatalogMetadataSource {
  listRecords(): readonly CatalogMetadataRecord[];
  findRecord(contentId: string): CatalogMetadataRecord | null;
}

/**
 * Why a record was not turned into a browsable item.
 *
 * Named reasons rather than a silently shorter list, for the same reason
 * `CatalogItemUnroutedReason` and `PlayBlockedReason` are named: a rail that is
 * one item short gives whoever is debugging it nothing to go on, and the two
 * causes here have completely different remedies -- one is "the rights review
 * has not happened", the other is "the source contradicted itself and should be
 * fixed or dropped".
 */
export type CatalogRecordRefusalReason =
  | "rights_basis_not_declared"
  | "rights_basis_contradicts_item";

export interface CatalogRecordRefusal {
  readonly contentId: string;
  readonly reason: CatalogRecordRefusalReason;
}

export interface CatalogRecordSelection {
  readonly items: readonly CatalogItem[];
  readonly refused: readonly CatalogRecordRefusal[];
}

/**
 * The records a browse surface may be built from, and a reason for each one that
 * was refused.
 *
 * TWO CHECKS, AND NEITHER OF THEM IS THE RIGHTS ALLOWLIST. That gate is
 * `isSurfaceable` in `lib/catalog.ts`, it runs on every item on the way onto a
 * rail and into a search result, and a second copy of it here would be a second
 * place to review whenever the allowlist changes. What this function decides is
 * the question that precedes it: has a source declared a basis at all, and does
 * what it declared agree with the item it declared it about.
 *
 *   - `rights_basis_not_declared` -- the source stated no basis. Refused rather
 *     than defaulted. `item.rights` is NOT read as a fallback: the contract
 *     forces that field to hold one of three values whether or not anybody
 *     established it, so trusting it here would convert "we have not checked" into
 *     "owned" for every work a source is quiet about.
 *   - `rights_basis_contradicts_item` -- the source declared one category and the
 *     published item carries another. Unreachable while a source builds both
 *     halves from one value, which is exactly what makes it worth checking: an
 *     ingestion that maps a provider's own rights field into `item.rights` and
 *     the register's category into `rights.category` has two inputs, and the day
 *     they disagree the honest answer is to publish neither.
 *
 * Fails closed in both directions and reports why. The refusals are returned
 * rather than logged so the caller decides what to do with them; nothing in this
 * module writes to a console.
 */
export function selectDeclaredItems(
  records: readonly CatalogMetadataRecord[]
): CatalogRecordSelection {
  const items: CatalogItem[] = [];
  const refused: CatalogRecordRefusal[] = [];

  for (const record of records) {
    const basis = record.rights;

    if (basis === null) {
      refused.push({ contentId: record.item.id, reason: "rights_basis_not_declared" });
      continue;
    }

    if (basis.category !== record.item.rights) {
      refused.push({ contentId: record.item.id, reason: "rights_basis_contradicts_item" });
      continue;
    }

    items.push(record.item);
  }

  return { items, refused };
}
