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
 * EVERY DISCOVERY SURFACE NOW READS THROUGH THIS PORT, and none of them holds
 * the direct import any more. The home rails reach it through `loadHomeCatalog`
 * in `lib/catalog.ts`, `app/search/search.ts` through
 * `resolveCatalogMetadataSource`, and `app/title/demo-title-details.ts` through
 * `demoCatalogSource`. `lib/demo-catalog.ts` still exports the raw `demoCatalog`
 * array, but its only remaining readers are test files, so the environment gate
 * in front of the fixtures is no longer bypassable from shipped code.
 *
 * This module is the interface such a provider would implement. It does not
 * implement one. There is no ingestion here, no refresh, no dedupe and no
 * network; see `docs/CATALOG_SOURCE.md` for the list of what is deliberately
 * unanswered.
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
 * WHAT IS NOT CHECKED HERE, stated rather than implied. `authorized-candidates.ts`
 * carries `OPAQUE_RIGHTS_REFERENCE_PATTERN`, a shape test that mechanically
 * excludes whitespace, prose, URLs and addresses from a reference. This module
 * does not apply it and does not restate it. Applying it would mean importing
 * that module, which value-imports `@liberty/media-engine` and
 * `@liberty/provider-sdk` -- pulling the playback ranking engine into the module
 * graph of every surface that renders a card -- and restating it would put a
 * second spelling of a rights rule in the repository, which is the defect that
 * file's own comment exists to prevent. So the shape of a catalog rights
 * reference is unenforced today. It is recorded in `docs/CATALOG_SOURCE.md` as
 * an open item, with the one honest fix: move the predicate to a leaf module
 * both sides can reach.
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
}

/**
 * A source that answers without awaiting.
 *
 * Narrower than the port and assignable to it. THE CALLER IT EXISTS FOR IS THE
 * TITLE SURFACE: `configuredSource` in `app/title/demo-title-details.ts` is
 * typed to this, because `findDemoTitleDetail` is synchronous -- `getTitleDetail`
 * in `app/title/title-detail.ts` is -- and a synchronous caller can only be
 * served by a source that answers synchronously. `DemoCatalogMetadataSource` in
 * `lib/demo-catalog.ts` is the one implementation.
 *
 * THE HOME ROUTE IS NO LONGER ONE OF ITS CALLERS, and the comment here used to
 * name it as the only one. `app/api/v1/catalog/home/route.ts` called a
 * synchronous `getHomeCatalog`, which has been deleted along with
 * `readFixtureCatalogItems`, the synchronous fixture accessor it defaulted to.
 * The route awaits `loadHomeCatalog` instead, so nothing on the home path needs
 * this narrowing.
 *
 * AN IN-PROCESS FIXTURE SATISFIES THIS AND A REAL PROVIDER WILL NOT, because a
 * provider does I/O. That asymmetry is not hidden -- it is exactly why the title
 * surface has to become asynchronous before a real source can land behind it,
 * and `docs/CATALOG_SOURCE.md` records that as an outstanding edit rather than
 * leaving it to be discovered.
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
