import {
  catalogHomeResponseSchema,
  type CatalogHomeResponse,
  type CatalogItem,
  type CatalogRail
} from "@liberty/contracts/domains/catalog";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import { selectDeclaredItems } from "./catalog-source";
import { resolveCatalogMetadataSource } from "./catalog-source-registry";

/**
 * Explicit result union. The home route has to distinguish "still loading",
 * "loaded but there is nothing to show" and "failed to load" — collapsing the
 * last two into an empty array is what produces the classic blank page that
 * looks identical whether the catalog is genuinely empty or the backend is
 * down.
 */
export type CatalogLoadResult =
  | { status: "ok"; response: CatalogHomeResponse }
  | { status: "empty"; generatedAt: string }
  | { status: "error"; reason: string };

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
  | CatalogHomeResponse
  | null
  | Promise<CatalogHomeResponse | null>;

/**
 * The source the home route uses when nothing is injected.
 *
 * Asynchronous, because the port is: a real metadata provider does I/O, and this
 * is the entry point it lands behind. It reads the whole record list and takes
 * only the items whose rights basis the source actually declared --
 * `selectDeclaredItems` refuses the rest, before `isSurfaceable` applies the
 * rights allowlist to what is left.
 */
export const defaultHomeCatalogSource: CatalogSource = async () => {
  const resolution = resolveCatalogMetadataSource();
  if (resolution.status === "not-configured") return null;

  const records = await resolution.source.listRecords();
  return buildHomeCatalog(selectDeclaredItems(records).items, new Date().toISOString());
};

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
): Promise<CatalogLoadResult> {
  try {
    const payload = await source();

    /*
     * Checked before validation, because there is nothing to validate. A source
     * that has no provider to ask is a configuration state, and it gets its own
     * reason code so it is not read as a malformed payload by whoever is looking
     * at the panel this renders into.
     */
    if (payload === null) {
      return { status: "error", reason: "catalog_source_not_configured" };
    }

    const parsed = catalogHomeResponseSchema.safeParse(payload);

    if (!parsed.success) {
      return { status: "error", reason: "catalog_response_failed_validation" };
    }
    if (parsed.data.rails.length === 0) {
      return { status: "empty", generatedAt: parsed.data.generatedAt };
    }
    return { status: "ok", response: parsed.data };
  } catch {
    return { status: "error", reason: "catalog_source_unavailable" };
  }
}
