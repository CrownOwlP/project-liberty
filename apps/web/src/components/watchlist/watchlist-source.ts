/* -------------------------------------------------------------------------
 * One list read per page, shared by every control on it (PW-0304).
 *
 * WHY THIS EXISTS. A control has to know whether the title is already on the
 * list, and it cannot be told on the server: reading a profile's list in a
 * server component would make every page that renders a catalog card dynamic,
 * which is the cost `components/auth/account-region.tsx` already declined to
 * pay for the session. So the client asks -- and a home rail has twenty cards,
 * so twenty controls asking separately would be twenty requests for one answer.
 *
 * A MODULE-LEVEL PROMISE, NOT A CACHE WITH A POLICY. The first caller starts
 * the request and every later caller awaits the same promise, so the page makes
 * exactly one. It is deliberately NOT invalidated on a mutation: each control
 * owns its own state after it acts, and a shared store that controls wrote back
 * into would be a second source of truth for the thing the server already
 * answered. The read exists to decide a FIRST PAINT.
 *
 * A FAILED READ IS `null`, WHICH MEANS UNKNOWN. It is not an empty list: a
 * signed-out viewer, an unconfigured deployment and a dropped connection all
 * produce "we do not know", and rendering those as "not on your list" would put
 * an Add button in front of someone whose list already holds the title.
 * ---------------------------------------------------------------------- */

/** The contentIds on this profile's list, or `null` when it could not be read. */
export type WatchlistSnapshot = readonly string[] | null;

/**
 * Pull the content ids out of a `listed` envelope.
 *
 * Pure, and defensive for the same reason `parseWatchlistAnswer` is: this runs
 * against whatever the network returned. Anything that is not a `listed`
 * envelope with an array of entries is `null` -- unknown -- rather than an
 * empty list.
 */
export function snapshotFromBody(body: unknown): WatchlistSnapshot {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record["outcome"] !== "listed") return null;
  const entries = record["entries"];
  if (!Array.isArray(entries)) return null;
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const contentId = (entry as { contentId?: unknown }).contentId;
    if (typeof contentId !== "string" || contentId === "") return null;
    ids.push(contentId);
  }
  return ids;
}

let inFlight: Promise<WatchlistSnapshot> | null = null;

/** Test seam; the module-level promise outlives a single test otherwise. */
export function resetWatchlistSnapshot(): void {
  inFlight = null;
}

export function readWatchlistSnapshot(): Promise<WatchlistSnapshot> {
  inFlight ??= (async () => {
    try {
      const response = await fetch("/api/v1/watchlist", {
        headers: { accept: "application/json" }
      });
      const body: unknown = await response.json().catch(() => null);
      return snapshotFromBody(body);
    } catch {
      return null;
    }
  })();
  return inFlight;
}
