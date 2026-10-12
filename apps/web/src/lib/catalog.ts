import {
  catalogHomeResponseSchema,
  type CatalogHomeResponse,
  type CatalogItem,
  type CatalogRail
} from "@liberty/contracts/domains/catalog";
import {
  PLAYABLE_CONTENT_RIGHTS,
  type ContentRights
} from "@liberty/contracts/shared/rights";
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

/* -------------------------------------------------------------------------
 * WHAT THE RIGHTS GATE DECIDED, IN WORDS (Wave 132, worker C).
 *
 * THE DEFECT CLASS REMOVED: an availability indicator that is a guess.
 *
 * Browse and search list titles and say nothing about why any of them is
 * listed. The obvious fix is the wrong one and is worth naming so it is not
 * attempted again: a badge reading "Available", "Playable" or "Ready to watch"
 * would be a claim this application cannot support anywhere on the discovery
 * path. `CatalogItem` carries no stream, no provider and no URL -- deliberately,
 * by its own contract header -- and a playable stream is resolved through
 * authorized provider adapters at playback time. An indicator that implied
 * otherwise would be a plausible-looking invention, which is precisely the thing
 * the installed desktop's missing catalog source already makes tempting.
 *
 * WHAT IS ACTUALLY KNOWN is narrower and completely truthful: the gate above
 * read `item.rights` and found it on `PLAYABLE_CONTENT_RIGHTS`. That is a real
 * field of a validated contract, it is the whole of the decision, and it is why
 * the item is on the page. So that is what these two functions report -- the
 * decision and its basis, nothing extrapolated from it.
 *
 * NO NEW FIELD AND NO SCHEMA CHANGE. Both read `item.rights`, which every
 * producer already populates because `contentRightsSchema` requires it. Nothing
 * here needs `packages/contracts` or `packages/catalog-ingestion` to grow a
 * column, which is the condition this wave set on surfacing availability at all.
 * ---------------------------------------------------------------------- */

/**
 * The rights basis, named the way it would be explained out loud.
 *
 * Keyed by the contract enum with no `default` branch, so a rights value added
 * to `contentRightsSchema` later is a TYPE ERROR here rather than a missing
 * word in the UI -- the same arrangement `PLAYABLE_CONTENT_RIGHTS` uses to make
 * a new value non-surfaceable until somebody reviews it.
 */
const RIGHTS_BASIS_LABEL: Readonly<Record<ContentRights, string>> = {
  licensed: "Licensed for this installation",
  owned: "From your own library",
  "public-domain": "Public domain"
};

/**
 * One line a discovery surface can print beside a listed title.
 *
 * DELIBERATELY NOT A PLAYABILITY STATEMENT. It is phrased as a statement about
 * rights, which is the only thing established at this point in the pipeline, and
 * it is total: the refused branch exists and says so, rather than returning an
 * empty string that would render as a blank line indistinguishable from a
 * missing label.
 *
 * THE REFUSED BRANCH IS UNREACHABLE FROM BROWSE AND SEARCH, AND IS WRITTEN
 * ANYWAY. Both surfaces run `isSurfaceable` before they build a list, so every
 * item that reaches a card has already passed. The branch exists because this
 * function is exported and the next caller may not have gated first -- and a
 * describer that silently calls an ungated item "licensed" is how a gate gets
 * reported as having passed when it was never run.
 */
export function describeSurfacedRightsBasis(item: CatalogItem): string {
  if (!isSurfaceable(item)) {
    return "Not available here: its rights basis is not one this installation may surface";
  }
  return RIGHTS_BASIS_LABEL[item.rights];
}

/* -------------------------------------------------------------------------
 * METADATA READ DE-DUPLICATION, MEASURED (Wave 132, worker C).
 *
 * THE DEFECT CLASS: a catalog port asked the same question several times inside
 * one request, and no way to tell whether a fix helped.
 *
 * Every discovery surface in this application reaches the metadata port the
 * same way -- `resolveCatalogMetadataSource(...)`, then `listRecords()`, then
 * `selectDeclaredItems`, which VALIDATES every record through zod and rebuilds
 * it. That last step is the expensive one, and it is per read rather than per
 * record: two reads of an unchanged catalog in one request do the whole
 * validation pass twice. `app/title/[titleId]/page.tsx` already found this the
 * hard way -- `generateMetadata` and the component body are two calls for one
 * request, and it wraps its loader in React's `cache` with a note that the two
 * answers "are not required to agree": a source that failed between them would
 * title the tab after a title the page says it could not load. That is the
 * defect, and it is a correctness defect before it is a performance one.
 *
 * WHAT THIS ADDS is the same guarantee as a reusable, MEASURED primitive rather
 * than one route's local fix, because the next surface to grow a second read
 * will not remember to repeat it.
 *
 * WHY NOT A CACHE WITH A TTL, which is what "metadata caching" usually means:
 * nothing here would know when to invalidate it. The port has no change feed,
 * no etag and no generation counter, so a TTL would be a guess about staleness
 * expressed as a number -- and on a local-first installation whose catalog
 * changes when the operator imports something, serving a stale list is a worse
 * failure than reading twice. Single-flight within a scope the caller OWNS has
 * no staleness window at all: a new scope reads again.
 *
 * LOCAL-FIRST AND NO DEPENDENCY, which is not a preference here. The cloud
 * ceiling is 0.0, so the only cache available to this surface is process memory,
 * and that is all this is.
 * ---------------------------------------------------------------------- */

/**
 * What a memo reports about its own traffic.
 *
 * MEASUREMENT IS PART OF THE PRIMITIVE AND NOT AN AFTERTHOUGHT. This wave's
 * instruction on caching was "measure, do not assume", and a cache with no
 * counter is a cache nobody can show is working -- or show has stopped working
 * when a later refactor accidentally constructs a fresh memo per call.
 * `catalog.test.ts` asserts on these numbers rather than on a feeling.
 */
export interface CatalogMemoStats {
  /** Reads that actually reached the underlying source. */
  readonly sourceReads: number;
  /** Reads served from the in-flight or settled answer instead. */
  readonly reuses: number;
}

export interface CatalogMemo<T> {
  read(): Promise<T>;
  stats(): CatalogMemoStats;
}

/**
 * Wrap a read so it happens at most once per memo.
 *
 * SINGLE-FLIGHT, AND THE PROMISE IS WHAT IS CACHED -- not the resolved value.
 * Caching the value would only de-duplicate reads that are strictly sequential;
 * two surfaces rendering CONCURRENTLY inside one request both arrive before
 * either answer exists, miss, and read twice, which is the exact case this is
 * for. Holding the promise means the second caller awaits the first caller's
 * read.
 *
 * A REJECTION IS NOT CACHED, deliberately, and the memo clears it. A cached
 * rejection would turn one transient provider fault into a permanently poisoned
 * scope, and these surfaces distinguish "the source threw" from "no source is
 * configured" precisely so the first one stays retryable. The retry is the next
 * caller's; this function does not retry on anybody's behalf, because it has no
 * idea whether asking again would produce anything different.
 *
 * `null` IS A VALUE AND IS CACHED LIKE ANY OTHER. On these ports `null` means
 * "no metadata source is configured", which is a settled fact about the
 * deployment rather than a failure -- re-asking inside one request cannot change
 * it, and treating it as a miss would read the registry once per surface to
 * receive the identical refusal.
 */
export function createCatalogMemo<T>(read: () => T | Promise<T>): CatalogMemo<T> {
  let inFlight: Promise<T> | null = null;
  let sourceReads = 0;
  let reuses = 0;

  return {
    read(): Promise<T> {
      if (inFlight !== null) {
        reuses += 1;
        return inFlight;
      }
      sourceReads += 1;
      const started = (async () => read())().catch((error: unknown) => {
        /* Not cached: see above. The next caller gets a fresh attempt. */
        if (inFlight === started) inFlight = null;
        throw error;
      });
      inFlight = started;
      return started;
    },
    stats(): CatalogMemoStats {
      return { sourceReads, reuses };
    }
  };
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
