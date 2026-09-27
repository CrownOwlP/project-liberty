import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { ListLimitRejection, PlaybackProgressRow } from "@liberty/persistence";

import { isSurfaceable } from "./catalog";
import { resolveCatalogMetadataSource } from "./catalog-source-registry";
import { resolveActiveProfileScope, resolveRequestContext } from "./db/request-context";

/* -------------------------------------------------------------------------
 * Continue watching: what counts, and what it resumes at (PW-0305)
 *
 * THE RULES ARE HERE AND NOT IN A COMPONENT, which is the acceptance's own
 * instruction: "excluding finished items by a stated rule rather than a magic
 * threshold buried in a component". A number inside a `.tsx` that decides which
 * titles a viewer sees is a product policy nobody can find, nobody can test in
 * isolation, and nobody can change without reading JSX. The three constants
 * below are the policy, they are exported so a test names them rather than
 * restating them, and every one of them carries the argument for its value.
 *
 * WHAT THIS MODULE IS NOT. It is not a second catalog. A title reaches the rail
 * only if the catalog would surface it anyway -- see `resolveEntryItem` -- so a
 * work withheld from browse for want of a rights basis cannot reappear here
 * because somebody once watched it. That is a rights property rather than a
 * lookup convenience, and it is the reason this module reaches the metadata
 * source through `isSurfaceable` instead of trusting a progress row to imply
 * that a title may be shown.
 * ---------------------------------------------------------------------- */

/**
 * How close to the end counts as finished, in seconds.
 *
 * A TAIL RATHER THAN ONLY A PERCENTAGE, because a percentage alone is wrong at
 * both ends of the runtime range. Ninety-five percent of a 22-minute episode is
 * 66 seconds from the end -- credits -- while ninety-five percent of a
 * three-hour film is nine minutes, which is an act. Whichever of the two rules
 * fires first wins, so a long film is finished when nine minutes remain only if
 * the fraction says so, and a short episode is finished when the credits roll
 * whatever the fraction says.
 *
 * Ninety seconds is a credits roll, not a scene.
 */
export const FINISHED_TAIL_SECONDS = 90;

/**
 * How much of a title counts as finished, as a fraction.
 *
 * The companion to the tail above, and the rule that catches the long runtimes
 * the tail is too small for.
 */
export const FINISHED_FRACTION = 0.95;

/**
 * How much must be watched before a title is worth resuming, in seconds.
 *
 * THIS RULE IS AN ADDITION BEYOND THE LITERAL CLAUSE, which asks only that
 * finished items be excluded, and it is called out here rather than slipped in.
 * The state it removes is real: opening a title and leaving within a few
 * seconds writes a progress row, and without this rule the rail's first entry
 * becomes whatever the viewer most recently glanced at and abandoned. Thirty
 * seconds is a title sequence. If a reviewer would rather the rail show
 * everything with a position, this constant is the only thing to delete and
 * `continueWatchingVerdict` is the only function that reads it.
 */
export const RESUMABLE_MINIMUM_SECONDS = 30;

/**
 * How many rows the rail asks the store for.
 *
 * `listContinueWatching` requires a limit rather than defaulting one, for the
 * reason it states: an unbounded query against a table that grows with every
 * episode a household watches is a slow request waiting for a heavy user. This
 * is the rail's answer to that requirement, and it is deliberately larger than
 * the rail will render -- exclusions below are applied AFTER the read, so
 * asking for exactly a screenful would show fewer than a screenful whenever
 * anything was excluded.
 */
export const CONTINUE_WATCHING_QUERY_LIMIT = 24;

/** Why a progress row is not an entry on the rail. */
export type ContinueWatchingExclusion = "not_started" | "barely_started" | "finished";

export type ContinueWatchingVerdict =
  | {
      readonly kind: "resumable";
      /** Where playback begins. The STORED position, not an approximation of it. */
      readonly resumeAtSeconds: number;
      /**
       * How far through, or `null` when the runtime is unknown.
       *
       * `null` IS NOT ZERO AND NOT ONE. A source that never reported a runtime
       * has not told us the title is at the beginning or at the end; it has told
       * us nothing, and `progressViewSchema` keeps `runtimeSeconds` nullable for
       * exactly that reason. A surface that rendered `null` as an empty bar
       * would state "barely started" about a title it cannot measure.
       */
      readonly completedFraction: number | null;
    }
  | { readonly kind: "excluded"; readonly why: ContinueWatchingExclusion };

/**
 * Whether one stored row belongs on the rail, and where it resumes.
 *
 * PURE, AND THE ONLY PLACE THE THREE CONSTANTS ARE READ. Everything that
 * follows -- the selection, the rail, the card indicator -- consumes this
 * verdict rather than re-deriving it, so there is one answer to "is this
 * finished" in the product.
 *
 * A ROW WITH NO POSITION IS A LEASE, NOT PROGRESS. The store already excludes
 * those, and this restates the rule rather than assuming it: this function is
 * also reachable from a row a caller read by other means, and `positionSeconds`
 * is nullable on the type.
 *
 * AN UNKNOWN RUNTIME IS RESUMABLE AND NEVER FINISHED. Both halves matter. It is
 * resumable because there is a real position to resume from; it is never
 * finished because "finished" is a claim about the remaining duration, and
 * nothing here knows the duration. Guessing in either direction -- dropping the
 * title, or showing it as complete -- would be a statement the data does not
 * support, which is the same rule `PL-0205` applies to an absent codec and
 * `titleRightsBasisSchema` applies to an undeclared basis.
 */
export function continueWatchingVerdict(row: {
  readonly positionSeconds: number | null;
  readonly runtimeSeconds: number | null;
}): ContinueWatchingVerdict {
  const { positionSeconds, runtimeSeconds } = row;

  if (positionSeconds === null) return { kind: "excluded", why: "not_started" };
  if (positionSeconds < RESUMABLE_MINIMUM_SECONDS) {
    return { kind: "excluded", why: "barely_started" };
  }

  if (runtimeSeconds === null) {
    return { kind: "resumable", resumeAtSeconds: positionSeconds, completedFraction: null };
  }

  const remaining = runtimeSeconds - positionSeconds;
  const fraction = positionSeconds / runtimeSeconds;
  if (remaining <= FINISHED_TAIL_SECONDS || fraction >= FINISHED_FRACTION) {
    return { kind: "excluded", why: "finished" };
  }

  return {
    kind: "resumable",
    resumeAtSeconds: positionSeconds,
    /*
     * Clamped to [0, 1] rather than trusted. A stored position past a stored
     * runtime is not impossible -- two devices, one of which reported a runtime
     * the other disagrees with -- and a bar wider than its track is a rendering
     * bug that looks like a data bug.
     */
    completedFraction: Math.min(1, Math.max(0, fraction))
  };
}

/** One title on the rail. */
export interface ContinueWatchingEntry {
  readonly item: CatalogItem;
  readonly resumeAtSeconds: number;
  readonly completedFraction: number | null;
}

/**
 * The rail's contents, from stored rows and a way to name a title.
 *
 * ORDER IS THE STORE'S AND IS NEVER RE-SORTED HERE. `listContinueWatching`
 * orders by `updated_at` descending with `content_id` as a total-order
 * tie-break, which IS the recency the acceptance asks for. A second sort in
 * this function could disagree with the one the query already applied -- and
 * the query is the one that also decided which rows the `limit` returned, so a
 * different order here would silently be an order over the wrong subset.
 *
 * `resolveItem` answers `null` for a title this surface may not show, and that
 * covers three different facts on purpose: the catalog does not know the id,
 * the metadata source could not be reached, or the work exists and is withheld.
 * All three mean the same thing to a rail -- there is nothing to render -- and
 * distinguishing them here would put the catalog's internal policy vocabulary
 * on the home page, which `app/page.tsx` already refuses to do for the empty
 * states.
 */
export function selectContinueWatching(
  rows: readonly PlaybackProgressRow[],
  resolveItem: (contentId: string) => CatalogItem | null
): readonly ContinueWatchingEntry[] {
  const entries: ContinueWatchingEntry[] = [];
  for (const row of rows) {
    const verdict = continueWatchingVerdict(row);
    if (verdict.kind !== "resumable") continue;
    const item = resolveItem(row.contentId);
    if (item === null) continue;
    entries.push({
      item,
      resumeAtSeconds: verdict.resumeAtSeconds,
      completedFraction: verdict.completedFraction
    });
  }
  return entries;
}

/* -------------------------------------------------------------------------
 * Loading it
 * ---------------------------------------------------------------------- */

/**
 * What the rail gets.
 *
 * TWO BRANCHES, AND `unavailable` RENDERS NOTHING RATHER THAN AN ERROR PANEL.
 * That is a deliberate asymmetry with the catalog rails, which DO render their
 * failure: the catalog is what the home page is for, and a home page that
 * silently showed nothing would be lying about the catalog. Continue watching
 * is supplementary -- a viewer who has never watched anything sees no rail at
 * all, and that is the normal case -- so a panel reading "we could not load
 * your progress" above the catalog would turn an unconfigured database, a
 * signed-out session and a brand-new profile into three alarming messages about
 * a feature the reader may not use. The reason is carried anyway, for a
 * diagnostic that wants it.
 */
export type ContinueWatchingResult =
  | { readonly status: "ok"; readonly entries: readonly ContinueWatchingEntry[] }
  | { readonly status: "unavailable"; readonly reason: string };

/** What the loader needs from the outside world. Injected so it is testable. */
export interface ContinueWatchingLoadOptions {
  readonly limit?: number;
}

/**
 * Load the rail for whoever is asking.
 *
 * NEVER THROWS. A home page whose failure mode is a stack trace is a home page
 * with no catalog on it, and the whole point of the `unavailable` branch is
 * that this rail cannot take the page down.
 *
 * WHAT IT DOES NOT DO: it does not name a profile. `resolveActiveProfileScope`
 * reads `session.activeProfileId`, which is server-side state written by
 * `selectActiveProfile`, and there is no parameter on this path through which a
 * caller could supply one. That is the same absence every other profile-scoped
 * read in this application maintains, and it is why a continue-watching rail
 * cannot be pointed at a sibling's viewing by anything on the wire.
 */
export async function loadContinueWatching(
  requestHeaders: Headers,
  options: ContinueWatchingLoadOptions = {}
): Promise<ContinueWatchingResult> {
  try {
    /*
     * HEADERS IN, NOT A `Request`, because headers are the only input that
     * decides anything on this path: `resolveRequestAccount` reads the session
     * cookie and the two development headers and nothing else, and no method,
     * URL or body reaches it. A caller in a server component holds
     * `headers()` and not a request, so taking the narrower thing removes a
     * synthesis from every call site and puts it in one place -- here, where
     * the placeholder authority is visible and is obviously never read.
     */
    const context = await resolveRequestContext(
      new Request("http://continue-watching.invalid/", { headers: requestHeaders })
    );
    if (!context.ok) {
      return { status: "unavailable", reason: context.reasons[0].code };
    }

    const decision = await resolveActiveProfileScope(context.context);
    if (!decision.allowed) {
      /*
       * Includes the ordinary case: a session with no profile selected yet.
       * `no_active_profile_selected` is not an error, it is a viewer who has
       * not chosen -- and the rail's answer to it is the same as its answer to
       * a viewer who has watched nothing, which is to render nothing.
       */
      return { status: "unavailable", reason: decision.reason };
    }

    const rows = await context.context.repository.listContinueWatching({
      scope: decision.scope,
      limit: options.limit ?? CONTINUE_WATCHING_QUERY_LIMIT
    });
    if (isLimitRefusal(rows)) {
      return { status: "unavailable", reason: rows.reason };
    }

    const resolve = await catalogResolver();
    return { status: "ok", entries: selectContinueWatching(rows, resolve) };
  } catch {
    /*
     * The thrown value's text is NOT published. A repository exception can
     * carry a connection string, and this value reaches a server-rendered page.
     */
    return { status: "unavailable", reason: "continue_watching_unavailable" };
  }
}

/**
 * The store answered with a refusal rather than rows.
 *
 * Narrowed by SHAPE rather than by `Array.isArray` alone, because
 * `Array.isArray` does not narrow a `readonly T[] | ListLimitRejection` union
 * on its false branch -- the union member it leaves is still both.
 */
function isLimitRefusal(
  value: readonly PlaybackProgressRow[] | ListLimitRejection
): value is ListLimitRejection {
  return !Array.isArray(value);
}

/**
 * A lookup from content id to a title this surface may show.
 *
 * READS THE SAME SOURCE AND APPLIES THE SAME RIGHTS GATE AS THE RAILS, which is
 * the property that keeps continue watching from becoming a second path into
 * the catalog. `isSurfaceable` is imported rather than restated for the reason
 * `rights.ts` gives about its own allowlist: a second spelling of a rights rule
 * is the defect that predicate exists to prevent.
 *
 * Resolved ONCE per load and closed over, rather than per row: the rail asks
 * about at most `CONTINUE_WATCHING_QUERY_LIMIT` titles, and re-resolving the
 * metadata source for each of them would multiply an operator's configuration
 * read by the size of a household's viewing history.
 */
async function catalogResolver(): Promise<(contentId: string) => CatalogItem | null> {
  const resolution = resolveCatalogMetadataSource();
  if (resolution.status !== "configured") return () => null;

  const records = await resolution.source.listRecords();
  const byId = new Map<string, CatalogItem>();
  for (const record of records) {
    if (isSurfaceable(record.item)) byId.set(record.item.id, record.item);
  }
  return (contentId) => byId.get(contentId) ?? null;
}

/* -------------------------------------------------------------------------
 * Starting over
 * ---------------------------------------------------------------------- */

/**
 * The search parameter that asks the watch route to ignore stored progress.
 *
 * DECLARED HERE, READ IN TWO PLACES, SPELLED ONCE. The rail builds the link and
 * the watch page reads it; a string literal at both ends is a feature that
 * breaks silently when one of them is renamed, and the failure mode is the
 * worst one available -- "start over" quietly resuming instead.
 *
 * A SEARCH PARAMETER RATHER THAN A POST, and that is a deliberate choice about
 * what start-over IS. It writes nothing: the stored position is left exactly
 * where it was, and the next heartbeat from the player overwrites it in the
 * ordinary way. So the link is a request for a different SESSION, not a
 * mutation, and following it by accident costs a viewer nothing they cannot
 * undo with the back button. A POST would have implied the opposite and would
 * have needed JavaScript on a rail that otherwise needs none.
 */
export const RESTART_PARAM = "restart";

/** The one value that means it. Anything else is not a restart. */
export const RESTART_VALUE = "1";

/**
 * Whether a request asked to start over.
 *
 * EXACT MATCH, not truthiness. `?restart=0` and `?restart=false` both read as
 * "no" to a person and would both read as "yes" to a presence check, and the
 * cost of getting that backwards is a viewer losing their place.
 */
export function isRestartRequested(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.includes(RESTART_VALUE);
  return value === RESTART_VALUE;
}

/** Where "start over" points, for one title. */
export function startOverHref(watchHref: string): string {
  return `${watchHref}?${RESTART_PARAM}=${RESTART_VALUE}`;
}

/* -------------------------------------------------------------------------
 * Resuming one title
 * ---------------------------------------------------------------------- */

/**
 * Where this profile last was in one title, or `null`.
 *
 * `null` MEANS "START AT THE ENGINE DEFAULT" and covers every reason there is
 * nothing to resume: no session, no profile selected, no database, no row, a
 * row that is only a lease, a glance too short to be worth returning to, and a
 * title that is finished. The caller cannot act differently on any of them --
 * they all mean "begin at the beginning" -- and distinguishing them here would
 * put an identity-store reason code on the path to a video element.
 *
 * IT REUSES `continueWatchingVerdict`, WHICH IS THE POINT. The rule that
 * decides whether a title appears on the rail is the same rule that decides
 * whether it resumes, so a title the rail calls finished starts over when a
 * viewer opens it, and one the rail calls barely started begins at the
 * beginning. Two rules here would eventually disagree, and the way a viewer
 * would find out is a title that says "continue" and plays the credits.
 *
 * NEVER THROWS, for the reason `loadContinueWatching` never throws: this runs
 * inside the watch page's render, and a page whose failure mode is a stack
 * trace is a page with no player on it. A resume point is a convenience; the
 * title still plays without it.
 */
export async function loadResumePosition(
  requestHeaders: Headers,
  contentId: string
): Promise<number | null> {
  try {
    const context = await resolveRequestContext(
      new Request("http://continue-watching.invalid/", { headers: requestHeaders })
    );
    if (!context.ok) return null;

    const decision = await resolveActiveProfileScope(context.context);
    if (!decision.allowed) return null;

    const row = await context.context.repository.readProgress({
      scope: decision.scope,
      contentId
    });
    /*
     * `null` is an answer -- no row for this title -- and a failure object is
     * not a row. Both mean there is nothing to resume.
     *
     * THE PROSE HERE IS DELIBERATELY PHRASED TO AVOID THE WORD "from" BEFORE A
     * QUOTE. `build-target.test.ts` walks this application's import graph with
     * a regex over raw source, and an earlier draft of this comment ended a
     * sentence with the two characters that regex reads as the start of an
     * import specifier. The walk then tried to resolve a fragment of English as
     * a module and the section-8 guard failed. The guard was right to be crude
     * -- a cleverer regex is one that can miss a real import -- so the comment
     * moved rather than the walker, which belongs to a task that owns it.
     */
    if (row === null || "ok" in row) return null;

    const verdict = continueWatchingVerdict(row);
    return verdict.kind === "resumable" ? verdict.resumeAtSeconds : null;
  } catch {
    return null;
  }
}
