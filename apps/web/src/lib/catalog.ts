import {
  catalogHomeResponseSchema,
  type CatalogHomeResponse,
  type CatalogItem,
  type CatalogRail
} from "@liberty/contracts/domains/catalog";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import { requireCatalogDescription } from "./catalog-ingestion-source";
import { selectDeclaredItems, type CatalogAnswer } from "./catalog-source";
import {
  resolveCatalogMetadataSource,
  type CatalogMetadataSourceResolution
} from "./catalog-source-registry";

/**
 * The two members `CatalogLoadResult` and `CatalogLoadOutcome` share verbatim,
 * named once so the pair below cannot drift apart.
 */
type CatalogLoadOk = { status: "ok"; response: CatalogHomeResponse };
type CatalogLoadError = { status: "error"; reason: string };

/**
 * WHY A HOME SURFACE HAS NO RAILS. Three answers, and the first two are the pair
 * PL-0305 taught the port to tell apart and this module used to collapse.
 *
 *   - `catalog_empty` -- the source listed nothing. There is no remedy because
 *     nothing is wrong.
 *   - `no_records_usable` -- the source listed records and not one of them
 *     reached a rail. Almost always for want of an operator rights basis, which
 *     is an operator action and not a user problem. The set is deliberately
 *     wider than the port's own `no_records_usable`: a source that answered
 *     `records_available` and then lost every record to `selectDeclaredItems`,
 *     to the rights allowlist or to the home-rail kinds is in the same position
 *     from the reader's side -- works exist, none of them may be shown here.
 *   - `cause_not_stated` -- nothing established which of the two it is. Reached
 *     when the source does not implement `describeCatalog`, which is LEGAL: the
 *     method is optional on the port precisely because the in-process fixture
 *     source has no pass behind it and could only answer by inventing one of the
 *     two states. Also reached when a source claims `catalog_empty` from a read
 *     it says was incomplete -- "there is nothing there" is not a claim a prefix
 *     of a source can support, and the port says so.
 *
 * IT IS NOT A THIRD FAILURE. `cause_not_stated` is an ordinary empty catalog
 * whose cause is unknown; nothing maps it onto an error, a status code or a
 * refusal.
 */
export type CatalogEmptyCause = "catalog_empty" | "no_records_usable" | "cause_not_stated";

/**
 * Explicit result union. The home route has to distinguish "still loading",
 * "loaded but there is nothing to show" and "failed to load" — collapsing the
 * last two into an empty array is what produces the classic blank page that
 * looks identical whether the catalog is genuinely empty or the backend is
 * down.
 *
 * `cause` IS OPTIONAL HERE AND REQUIRED ON `CatalogLoadOutcome` BELOW, and the
 * split is load-bearing rather than decorative. This union is what
 * `app/api/v1/catalog/home/handler.ts` ACCEPTS -- including from its own tests,
 * which construct a decided result by hand to reach the HTTP mapping without a
 * loader -- so making the field mandatory here would force an edit to a file
 * outside this task's write surface for no behavioural gain. What must not be
 * optional is what the LOADER produces, and that is the narrower type.
 */
export type CatalogLoadResult =
  | CatalogLoadOk
  | { status: "empty"; generatedAt: string; cause?: CatalogEmptyCause }
  | CatalogLoadError;

/**
 * What `loadHomeCatalog` returns: the same union with `cause` mandatory.
 *
 * Assignable to `CatalogLoadResult`, and built from the same two shared members
 * so the pair cannot drift into two hand-maintained descriptions of one result.
 * A loader branch that produced an empty result without saying why is a compile
 * error, and `app/page.tsx` reads this type, so its panel table is total over
 * `CatalogEmptyCause` rather than carrying an `undefined` case that duplicates
 * `cause_not_stated`.
 */
export type CatalogLoadOutcome =
  | CatalogLoadOk
  | { status: "empty"; generatedAt: string; cause: CatalogEmptyCause }
  | CatalogLoadError;

/** Rights gate. Anything not on the allowlist is never surfaced. */
export function isSurfaceable(item: CatalogItem): boolean {
  return PLAYABLE_CONTENT_RIGHTS.includes(item.rights);
}

export function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

/**
 * Display string for a card, derived from structured fields rather than stored.
 *
 * This used to carry null-guards on both shape fields and a genre-only
 * fallback for the case where neither was known. `CatalogItem` is now a
 * discriminated union in which a series always has an episode count and a
 * movie or episode always has a runtime, so that third state is unrepresentable
 * and the guards would be dead code. Everything reaching here has been parsed
 * through `catalogHomeResponseSchema`, so the invariant holds at runtime too.
 */
export function formatCatalogMeta(item: CatalogItem): string {
  const shape =
    item.kind === "series"
      ? `${item.episodeCount} episodes`
      : formatRuntime(item.runtimeMinutes);
  return [item.genre, shape].join(" · ");
}

/**
 * Home rails are intentionally limited to top-level browsable kinds. Individual
 * `episode` items are reachable through their series (PL-0103), never as a
 * standalone home-rail entry, so they are deliberately not surfaced here.
 */
const RAIL_DEFINITIONS: ReadonlyArray<{ id: string; title: string; kind: CatalogItem["kind"] }> = [
  { id: "movies", title: "Films", kind: "movie" },
  { id: "series", title: "Series", kind: "series" }
];

/** Kinds that appear on the home surface. */
export const HOME_RAIL_KINDS: ReadonlyArray<CatalogItem["kind"]> = RAIL_DEFINITIONS.map(
  (definition) => definition.kind
);

/** True when an item is both rights-cleared and eligible for a home rail. */
export function appearsOnHome(item: CatalogItem): boolean {
  return isSurfaceable(item) && HOME_RAIL_KINDS.includes(item.kind);
}

/**
 * Pure and deterministic: same items in, same rails out. Rails with no
 * surfaceable items are omitted entirely rather than rendered empty.
 */
export function buildHomeCatalog(
  items: readonly CatalogItem[],
  generatedAt: string
): CatalogHomeResponse {
  const surfaceable = items.filter(isSurfaceable);

  const rails: CatalogRail[] = RAIL_DEFINITIONS.map((definition) => ({
    id: definition.id,
    title: definition.title,
    items: surfaceable
      .filter((item) => item.kind === definition.kind)
      .sort((a, b) => b.releaseYear - a.releaseYear || a.title.localeCompare(b.title))
  })).filter((rail) => rail.items.length > 0);

  return { rails, generatedAt };
}

/*
 * THERE IS NO SYNCHRONOUS `getHomeCatalog` ANY MORE.
 *
 * It used to sit here, returning a `CatalogHomeResponse` built from a
 * synchronous read of the fixture source, and `app/api/v1/catalog/home/route.ts`
 * was its only production caller. A `CatalogHomeResponse` has nowhere to say "no
 * metadata source is configured", so on a deployment it produced no rails and
 * the route served `{ rails: [] }` at 200 -- a statement about the catalog made
 * by a process with no catalog to look at.
 *
 * That route now awaits `loadHomeCatalog` below, whose result union carries a
 * reason, and `app/api/v1/catalog/home/handler.ts` maps
 * `catalog_source_not_configured` onto 503. With the route moved, the
 * synchronous variant had only test callers left; it was deleted rather than
 * kept alive for them, and `readFixtureCatalogItems` in
 * `lib/catalog-source-registry.ts` -- which existed only to be its default
 * argument -- was deleted with it. `buildHomeCatalog` above is the pure function
 * both of them wrapped, and it is what the tests state a catalog through now.
 */

/**
 * Where the home catalog comes from. Injectable so the loader's failure paths
 * are testable, and so a metadata provider can replace the fixtures without the
 * route changing.
 *
 * `null` MEANS NO SOURCE IS CONFIGURED, and it is the one thing an empty
 * response cannot say. A catalog has no "not found" state -- there is nothing to
 * look up -- so the `null` convention `TitleDetailSource` uses for not-found is
 * free here, and it is spent on the distinction that actually matters: a
 * deployment with no metadata provider is not a deployment whose catalog is
 * empty. The first has an operator remedy; the second is a fact about the
 * catalog, and rendering the first as the second is how "no titles are available
 * in your region" ends up on screen when nothing has ever been ingested.
 */
export type CatalogSource = () =>
  | HomeCatalogAnswer
  | null
  | Promise<HomeCatalogAnswer | null>;

/**
 * What a source answers when it has one: the payload, and why it is as short as
 * it is.
 *
 * TWO FIELDS BECAUSE `payload` CANNOT CARRY THE SECOND ONE. A
 * `CatalogHomeResponse` is the published browse shape and it has exactly one way
 * to say "nothing" — `rails: []` — which is the collapse this task exists to
 * undo one level further out. Widening the contract instead is a package edit
 * and a review; the cause is a fact about THIS READ rather than part of the
 * published catalog, so it rides beside the payload and never inside it.
 *
 * `payload` IS UNVALIDATED. `loadHomeCatalog` is the one place
 * `catalogHomeResponseSchema` runs, so a source that composes a malformed
 * response still reaches `catalog_response_failed_validation` rather than being
 * trusted here.
 */
export interface HomeCatalogAnswer {
  readonly payload: CatalogHomeResponse;
  readonly cause: CatalogEmptyCause;
}

/**
 * The source the home route uses when nothing is injected.
 *
 * Asynchronous, because the port is: a real metadata provider does I/O, and this
 * is the entry point it lands behind. It takes only the items whose rights basis
 * the source actually declared -- `selectDeclaredItems` refuses the rest, before
 * `isSurfaceable` applies the rights allowlist to what is left -- and it carries
 * the source's own account of why the result is as short as it is.
 *
 * IT TAKES NO ARGUMENT, and that is the point of the split below. Nothing on a
 * request path may name the source it wants read; the resolution comes from the
 * registry and from nowhere else.
 */
export const defaultHomeCatalogSource: CatalogSource = () =>
  readHomeCatalogFrom(resolveCatalogMetadataSource());

/**
 * Why the home surface is empty, read off a source's own description.
 *
 * `complete === false` IS CHECKED BEFORE `catalog_empty` IS REPEATED. The port
 * states that an incomplete read makes `catalog_empty` unreachable, because the
 * absences in such an answer are absences from a PREFIX of the source. A source
 * that says both anyway has contradicted itself, and the honest reading of a
 * contradiction is that nothing was established — not that the catalog is
 * empty, which is the half a reader would act on.
 *
 * EVERY OTHER STATE BECOMES `no_records_usable`, INCLUDING `records_available`.
 * This function is only ever consulted for an answer that produced no rails, and
 * a source that listed records and still produced none is, from the reader's
 * side, the state whose remedy is an operator action. Mapping
 * `records_available` onto `cause_not_stated` instead would throw away a fact
 * the source did state: there ARE records.
 */
function emptyCauseOf(answer: CatalogAnswer): CatalogEmptyCause {
  if (answer.state === "catalog_empty") {
    return answer.complete ? "catalog_empty" : "cause_not_stated";
  }
  return "no_records_usable";
}

/**
 * Turn a resolved metadata source into an answer, or `null` when there is none.
 *
 * SEPARATE FROM `defaultHomeCatalogSource` SO THE COMPOSITION IS REACHABLE. The
 * constant above is the production wiring and takes no argument by design —
 * nothing on a request path may name its own source. A test that needs the REAL
 * composition (this function, `requireCatalogDescription`, `selectDeclaredItems`
 * and `buildHomeCatalog` in the real order) over a source it controls hands the
 * resolution in here instead of reimplementing the sequence, which is how a
 * regression can drive both empty states through the loader that ships.
 *
 * `describeCatalog` IS OPTIONAL ON THE PORT AND ITS ABSENCE IS NOT A FAILURE.
 * `requireCatalogDescription` answers `null` for a source that cannot describe
 * itself — the in-process fixture source has no pass behind it and could only
 * answer by inventing one of the two states — and that branch reads
 * `listRecords()` exactly as this module always did. The result is an ordinary
 * catalog whose cause is `cause_not_stated`; nothing about it is reported as an
 * error, and no `?.` call is left anywhere for the check and the call to
 * disagree over.
 *
 * THE WITHHELD LIST IS READ FOR ITS SHAPE AND DISCARDED. `answer.withheld`
 * carries `@liberty/catalog-ingestion`'s own reason vocabulary —
 * `rights_basis_not_declared`, `availability_not_stated` and the rest — which is
 * operator diagnostics, not user copy. Nothing here copies one of those strings
 * into a `CatalogLoadResult`, so there is no path by which one can reach a
 * rendered page: the distinction that survives to the user is the CAUSE, and the
 * reasons behind it stay on the source side of this boundary.
 */
export async function readHomeCatalogFrom(
  resolution: CatalogMetadataSourceResolution
): Promise<HomeCatalogAnswer | null> {
  if (resolution.status === "not-configured") return null;

  const describe = requireCatalogDescription(resolution.source);
  const generatedAt = new Date().toISOString();

  if (describe === null) {
    const records = await resolution.source.listRecords();
    return {
      payload: buildHomeCatalog(selectDeclaredItems(records).items, generatedAt),
      cause: "cause_not_stated"
    };
  }

  const answer = await describe();
  return {
    payload: buildHomeCatalog(selectDeclaredItems(answer.records).items, generatedAt),
    cause: emptyCauseOf(answer)
  };
}

/**
 * The one entry point both home surfaces read through.
 *
 * `app/page.tsx` awaits it during its server render and
 * `app/api/v1/catalog/home/route.ts` awaits it as well, so the route never has
 * to make an HTTP call back into itself and the two cannot disagree about what
 * the catalog holds or why it is missing. Nothing calls a synchronous variant,
 * because there no longer is one.
 *
 * Validates against the published contract so a malformed fixture or provider
 * payload becomes a handled error state instead of a runtime crash mid-render. A
 * source that throws (network, timeout, an adapter fault) is likewise converted
 * rather than propagated.
 */
export async function loadHomeCatalog(
  source: CatalogSource = defaultHomeCatalogSource
): Promise<CatalogLoadOutcome> {
  try {
    const answer = await source();

    /*
     * Checked before validation, because there is nothing to validate. A source
     * that has no provider to ask is a configuration state, and it gets its own
     * reason code so it is not read as a malformed payload by whoever is looking
     * at the panel this renders into.
     */
    if (answer === null) {
      return { status: "error", reason: "catalog_source_not_configured" };
    }

    const parsed = catalogHomeResponseSchema.safeParse(answer.payload);

    if (!parsed.success) {
      return { status: "error", reason: "catalog_response_failed_validation" };
    }
    if (parsed.data.rails.length === 0) {
      /*
       * THE LINE THIS TASK EXISTS FOR. It used to stop at `generatedAt`, which
       * made a catalog whose every record was withheld indistinguishable from a
       * catalog with nothing in it — the last place PL-0305's four states
       * collapsed back into one before reaching a reader. The cause comes from
       * the source's own description and is never inferred from the fact that
       * the array is short, because an empty array is exactly what both states
       * legitimately produce.
       */
      return { status: "empty", generatedAt: parsed.data.generatedAt, cause: answer.cause };
    }
    return { status: "ok", response: parsed.data };
  } catch {
    return { status: "error", reason: "catalog_source_unavailable" };
  }
}
