import {
  catalogHomeResponseSchema,
  type CatalogHomeResponse,
  type CatalogItem,
  type CatalogRail
} from "@liberty/contracts/domains/catalog";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import { demoCatalog } from "./demo-catalog";

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

/**
 * Server-side catalog source. The API route and the home page both read
 * through this, so neither can drift from the other and the page never has to
 * make an HTTP call back into itself.
 */
export function getHomeCatalog(
  now: Date = new Date(),
  items: readonly CatalogItem[] = demoCatalog
): CatalogHomeResponse {
  return buildHomeCatalog(items, now.toISOString());
}

/**
 * Where the home catalog comes from. Injectable so the loader's failure paths
 * are testable, and so PL-0301 can swap the fixtures for a provider adapter
 * without touching the route.
 */
export type CatalogSource = () => CatalogHomeResponse | Promise<CatalogHomeResponse>;

/**
 * Loader used by the home route. Validates against the published contract so a
 * malformed fixture or provider payload becomes a handled error state instead
 * of a runtime crash mid-render. A source that throws (network, timeout, an
 * adapter fault) is likewise converted rather than propagated.
 */
export async function loadHomeCatalog(
  source: CatalogSource = () => getHomeCatalog()
): Promise<CatalogLoadResult> {
  try {
    const parsed = catalogHomeResponseSchema.safeParse(await source());

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
