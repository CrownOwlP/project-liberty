import {
  PLAYABLE_CONTENT_RIGHTS,
  catalogHomeResponseSchema,
  type CatalogHomeResponse,
  type CatalogItem,
  type CatalogRail
} from "@liberty/contracts";
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

/** Display string for a card, derived from structured fields rather than stored. */
export function formatCatalogMeta(item: CatalogItem): string {
  const parts: string[] = [item.genre];
  if (item.kind === "series" && item.episodeCount !== null) {
    parts.push(`${item.episodeCount} episodes`);
  } else if (item.runtimeMinutes !== null) {
    parts.push(formatRuntime(item.runtimeMinutes));
  }
  return parts.join(" · ");
}

const RAIL_DEFINITIONS: ReadonlyArray<{ id: string; title: string; kind: CatalogItem["kind"] }> = [
  { id: "movies", title: "Films", kind: "movie" },
  { id: "series", title: "Series", kind: "series" }
];

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
 * Loader used by the home route. Validates against the published contract so a
 * malformed fixture or provider payload becomes a handled error state instead
 * of a runtime crash mid-render.
 */
export async function loadHomeCatalog(
  now: Date = new Date(),
  items: readonly CatalogItem[] = demoCatalog
): Promise<CatalogLoadResult> {
  try {
    const parsed = catalogHomeResponseSchema.safeParse(getHomeCatalog(now, items));

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
