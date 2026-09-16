import { catalogItemSchema, type CatalogItem } from "@liberty/contracts/domains/catalog";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { assessFreshness, type DatedAnswer, type StalenessPolicy } from "./freshness";
import type { AcceptedWork } from "./provider";
import type { LocalizedText, Territory } from "./record";

/* -------------------------------------------------------------------------
 * From an ingested record to something a rail can render
 *
 * THIS IS WHERE THE LOCALE AND THE TERRITORY ARE CHOSEN, and it is deliberately
 * the last step rather than the first. An ingested record holds every locale a
 * source offered and every territory it named; a `CatalogItem` holds one title,
 * one genre and no territory at all. Collapsing the first into the second is a
 * decision that depends on WHO IS ASKING, so it happens at the read, with the
 * asker's preferences in hand, and not during ingestion where nothing knows
 * them.
 *
 * ==========================================================================
 * THE OUTPUT IS STRUCTURALLY THE PORT'S RECORD, WITHOUT EITHER SIDE IMPORTING
 * THE OTHER
 * ==========================================================================
 *
 * `ProjectedCatalogRecord` below has exactly the two fields
 * `CatalogMetadataRecord` has in `apps/web/src/lib/catalog-source.ts`: a
 * `CatalogItem` from `@liberty/contracts`, and a nullable basis of a
 * `ContentRights` category plus an opaque reference. Both sides are written in
 * the published contracts and neither imports the other, so an array of these is
 * assignable to the port's record type by TypeScript's structural typing alone.
 *
 * THAT IS A DELIBERATE SEAM AND NOT A COINCIDENCE, and there is a constraint
 * behind it worth stating plainly: `apps/web` cannot currently depend on this
 * package. Declaring the dependency means editing `apps/web/package.json`, which
 * is outside PL-0305's `allowedPaths`, and adding any new workspace package
 * requires a `package-lock.json` entry, which is outside it too. So the adapter
 * that turns these records into a `CatalogMetadataSource` is a few lines that
 * belong in `catalog-source-registry.ts` and cannot be written there yet.
 * `docs/CATALOG_SOURCE.md` records the exact remaining edits. Nothing here
 * pretends that gap is closed.
 *
 * NO MEDIA ADDRESS CAN REACH THIS SHAPE. `CatalogItem` has no url, image or
 * stream field -- `packages/contracts/src/domains/catalog.ts` says so in its
 * header -- and artwork is DROPPED here rather than mapped, because there is
 * nowhere for it to go and because carrying an image would mean carrying an
 * image licence onto a surface. Catalog metadata and playback resolution stay
 * different boundaries: this function says a work exists, and nothing it returns
 * says where to fetch it from.
 * ---------------------------------------------------------------------- */

/**
 * Exactly the shape `apps/web`'s `CatalogRightsBasis` has.
 *
 * Restated structurally rather than imported, because the import would point the
 * wrong way -- a package cannot depend on the application that consumes it -- and
 * because both spellings are made of published contract types, so neither is a
 * new vocabulary. The risk this carries is drift: if the port grows a third
 * field, this stops being assignable and the day it does the compile error is at
 * the adapter in the registry, which is where somebody should be looking.
 */
export interface ProjectedRightsBasis {
  readonly category: ContentRights;
  readonly reference: string | null;
}

export interface ProjectedCatalogRecord {
  readonly item: CatalogItem;
  readonly rights: ProjectedRightsBasis | null;
}

/**
 * How an unstated availability is to be read.
 *
 * NO DEFAULT, AND THE CALLER MUST CHOOSE. A source that names no territory has
 * told us nothing, and the two readings -- "assume worldwide" and "assume
 * nothing, show it nowhere" -- are both defensible and have opposite
 * consequences. Picking one here would bury a product-and-rights decision in a
 * default argument. `refuse` is the fail-closed reading and is what an operator
 * with real availability data should use; `treat_as_worldwide` is for a source
 * that genuinely does not model territories and whose licence position is
 * established some other way.
 */
export type UnstatedAvailability = "refuse" | "treat_as_worldwide";

export interface ProjectionRequest {
  /** Preferred locales, most preferred first. */
  readonly locales: readonly string[];
  readonly territory: Territory;
  /** The instant availability windows are evaluated against. */
  readonly atMs: number;
  readonly unstatedAvailability: UnstatedAvailability;
}

export type ProjectionRefusal =
  | "no_title_in_requested_locales"
  | "no_genre_in_requested_locales"
  | "availability_not_stated"
  | "not_available_in_territory"
  | "item_failed_contract_validation";

export type Projection =
  | { readonly ok: true; readonly record: ProjectedCatalogRecord }
  | { readonly ok: false; readonly reason: ProjectionRefusal; readonly detail: string };

/**
 * Picks the best locale-tagged value for a request.
 *
 * TWO ROUNDS, EXACT THEN PRIMARY-SUBTAG, and never a fallback to "whatever the
 * source listed first". A reader who asked for French and is handed Japanese
 * because it happened to be first has been given a worse answer than an honest
 * refusal, and the refusal is something a caller can react to -- by widening the
 * locale list, or by showing the work under a neutral label -- while a silent
 * wrong-language title is indistinguishable from a correct one.
 *
 * The primary-subtag round is what makes `en` match `en-GB` and `en-US`. It runs
 * as a SECOND pass over the whole preference list rather than interleaved,
 * because an exact match on a less-preferred locale still beats an approximate
 * match on a more-preferred one.
 */
export function selectLocalized(
  entries: readonly LocalizedText[],
  locales: readonly string[]
): LocalizedText | null {
  for (const locale of locales) {
    const exact = entries.find((entry) => entry.locale === locale);
    if (exact !== undefined) return exact;
  }
  for (const locale of locales) {
    const primary = locale.split("-")[0];
    if (primary === undefined) continue;
    const loose = entries.find((entry) => entry.locale.split("-")[0] === primary);
    if (loose !== undefined) return loose;
  }
  return null;
}

/**
 * Whether a work is offered here, now.
 *
 * `WW` on a window matches every territory; the requested territory is never
 * `WW` in practice but is allowed to be, and then matches only worldwide
 * windows -- asking "what is available everywhere" is a coherent question and
 * silently widening it to "available somewhere" would not be.
 *
 * A window with `startsAt: null` has always been open and one with
 * `endsAt: null` never closes. Both ends are INCLUSIVE of the boundary instant,
 * which matters only for one millisecond a year but matters entirely for the
 * test that picks exactly that instant.
 */
export function isAvailable(
  windows: readonly { readonly territory: Territory; readonly startsAt: string | null; readonly endsAt: string | null }[],
  territory: Territory,
  atMs: number
): boolean {
  return windows.some((window) => {
    if (window.territory !== "WW" && window.territory !== territory) return false;
    if (window.startsAt !== null && Date.parse(window.startsAt) > atMs) return false;
    if (window.endsAt !== null && Date.parse(window.endsAt) < atMs) return false;
    return true;
  });
}

/**
 * One ingested work, as a browse record for one reader.
 *
 * The item is built and then PARSED with `catalogItemSchema` rather than
 * asserted into the type. That parse is what enforces the contract's
 * kind/runtime/episode-count discriminated union -- a series with a runtime, or
 * a movie with an episode count, is refused here by the contract's own rule
 * instead of by a second copy of it in `record.ts` that could drift.
 *
 * `rights` is carried through from the ingested basis and `item.rights` is set
 * FROM THE SAME VALUE, so the two cannot contradict each other. The port's
 * `rights_basis_contradicts_item` check is therefore unreachable from this
 * projection -- which is what the port's own comment predicts, and is the reason
 * that check exists for sources that build the two halves from two inputs.
 */
export function projectToCatalogRecord(
  accepted: AcceptedWork,
  request: ProjectionRequest
): Projection {
  const work = accepted.work;

  if (work.availability.length === 0) {
    if (request.unstatedAvailability === "refuse") {
      return {
        ok: false,
        reason: "availability_not_stated",
        detail: `${work.contentId} names no territory`
      };
    }
  } else if (!isAvailable(work.availability, request.territory, request.atMs)) {
    return {
      ok: false,
      reason: "not_available_in_territory",
      detail: `${work.contentId} is not offered in ${request.territory}`
    };
  }

  const title = selectLocalized(work.titles, request.locales);
  if (title === null) {
    return {
      ok: false,
      reason: "no_title_in_requested_locales",
      detail: `${work.contentId} has no title in the requested locales`
    };
  }

  const genre = selectLocalized(work.genres, request.locales);
  if (genre === null) {
    return {
      ok: false,
      reason: "no_genre_in_requested_locales",
      detail: `${work.contentId} has no genre in the requested locales`
    };
  }

  const basis = work.rights;
  const parsed = catalogItemSchema.safeParse({
    id: work.contentId,
    title: title.value,
    kind: work.kind,
    // `basis?.category` is not used: a work whose basis is null must still
    // produce a parseable item so the PORT can refuse it by name. `owned` would
    // be a fabrication, so the projection refuses to guess and the contract's
    // requirement is met with the most restrictive value in the vocabulary.
    // Nothing reads it -- `rights: null` below is what a consumer gates on.
    rights: basis === null ? ("licensed" satisfies ContentRights) : basis.category,
    genre: genre.value,
    releaseYear: work.releaseYear,
    runtimeMinutes: work.runtimeMinutes,
    episodeCount: work.episodeCount
  });

  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    return {
      ok: false,
      reason: "item_failed_contract_validation",
      detail: `invalid at: ${paths}`
    };
  }

  return {
    ok: true,
    record: {
      item: parsed.data,
      rights: basis === null ? null : { category: basis.category, reference: basis.reference }
    }
  };
}

export interface ProjectionOutcome {
  readonly records: readonly ProjectedCatalogRecord[];
  readonly refused: readonly { readonly contentId: string; readonly reason: ProjectionRefusal }[];
}

/**
 * The same projection over a set, with every answer carrying its age.
 *
 * THE FRESHNESS VERDICT IS COMPUTED FROM THE OLDEST RECORD IN THE SET, not the
 * newest and not the mean. A rail is as current as its stalest row: reporting
 * the newest would let one just-refreshed record describe a page of week-old
 * ones as fresh, which is the specific dishonesty "an answer carries its age"
 * exists to prevent.
 *
 * An empty set has no age, so there is nothing to date, and this answers `null`
 * rather than inventing `now` -- which would claim a freshly-observed empty
 * catalog when what happened is that everything was refused.
 */
export function projectCatalogAnswer(
  works: readonly AcceptedWork[],
  request: ProjectionRequest,
  policy: StalenessPolicy,
  nowMs: number
): DatedAnswer<ProjectionOutcome> | null {
  const records: ProjectedCatalogRecord[] = [];
  const refused: { contentId: string; reason: ProjectionRefusal }[] = [];
  let oldest: string | null = null;

  for (const accepted of works) {
    if (oldest === null || Date.parse(accepted.observedAt) < Date.parse(oldest)) {
      oldest = accepted.observedAt;
    }
    const projection = projectToCatalogRecord(accepted, request);
    if (!projection.ok) {
      refused.push({ contentId: accepted.work.contentId, reason: projection.reason });
      continue;
    }
    records.push(projection.record);
  }

  if (oldest === null) return null;

  const assessment = assessFreshness(oldest, nowMs, policy);
  if (!assessment.ok) return null;

  return { value: { records, refused }, verdict: assessment.verdict };
}
