import type { ListLimitRejection, PlaybackProgressRow } from "@liberty/persistence";

import { continueWatchingVerdict } from "./continue-watching";
import { resolveActiveProfileScope, resolveRequestContext } from "./db/request-context";

/* -------------------------------------------------------------------------
 * How far through each episode this profile is (PW-0307)
 *
 * WHAT IT IS FOR. The episode list shows every episode of a series and says
 * nothing about which of them the viewer has watched. The acceptance asks for
 * "per-episode watched and in-progress state from the progress API", and this
 * is the read and the classification; `components/title/episode-list.tsx`
 * renders the answer and decides nothing.
 *
 * THE CLASSIFICATION IS NOT RE-DERIVED, AND THAT IS THE POINT OF THIS MODULE
 * EXISTING AT ALL. `continueWatchingVerdict` already decides resumable /
 * finished / barely-started from one row; it is exported, it carries the three
 * constants the product's policy is made of, and both the continue-watching
 * rail and `loadResumePosition` consume it. A second opinion about what
 * "finished" means would be visible to a viewer as an episode this list marks
 * watched and the player then starts from the beginning -- which is exactly the
 * disagreement that function was written to make impossible.
 *
 * ==========================================================================
 * ONE QUERY, NOT ONE PER EPISODE
 * ==========================================================================
 *
 * The obvious implementation is `readProgress` per row. A ten-episode season
 * would then be ten round trips inside one render, and a twenty-episode series
 * twenty. `listContinueWatching` answers the same question in one statement,
 * and this module filters it down to the episodes the page is showing.
 *
 * THE PAGE SIZE IS A DECISION HERE, WITH A REASON, which is what
 * `parseListLimit` asks of its callers: "NO UPPER BOUND IS IMPOSED, on
 * purpose. Any ceiling written here would be a number nobody chose ... The
 * call site owns the page size and `limit` is required so that ownership is
 * visible; a cap belongs there, with a reason, not here."
 *
 * WHAT IT COSTS, STATED RATHER THAN HIDDEN. The query returns a profile's most
 * recently-updated rows across the WHOLE product, not the ones belonging to
 * this series, so a household whose last `EPISODE_PROGRESS_QUERY_LIMIT` rows
 * are all other titles will see an episode's state missing even though it is
 * stored. The answer in that case is `unknown`, never "not watched" -- see
 * `EpisodeProgress` below, where that distinction is the whole type. A
 * series-scoped query would remove the limitation and does not exist:
 * `@liberty/persistence` has no "progress for these content ids" method, and
 * adding one is a change to a package this task does not own. Named here so it
 * is a known bound rather than a surprise.
 * ---------------------------------------------------------------------- */

/**
 * How many rows the episode list asks the store for.
 *
 * Two hundred, and the number is argued rather than picked. A season of
 * television is rarely more than about twenty-five episodes and a long-running
 * series rarely more than about two hundred in total, so this covers a viewer
 * who has watched an entire series and nothing else. It is deliberately much
 * larger than `CONTINUE_WATCHING_QUERY_LIMIT` (24), because that one bounds a
 * rail that renders five tiles and this one has to cover every episode on a
 * page at once.
 *
 * It is not unbounded. An unbounded read against a table that grows with every
 * episode a household watches is the slow query `listContinueWatching` requires
 * a limit to prevent, and the requirement exists so that somebody chooses.
 */
export const EPISODE_PROGRESS_QUERY_LIMIT = 200;

/**
 * What the list knows about one episode.
 *
 * THREE STATES AND `unknown` IS A REAL ONE. "Not watched" is a claim about the
 * viewer; "we did not read anything" is a claim about this request. A page that
 * rendered a failed read as "not watched" would tell a household they have not
 * seen an episode on the strength of never having looked -- the same
 * substitution `app/page.tsx` refuses when it answers
 * `catalog_source_not_configured` instead of `empty`, and the same one
 * `watchlist-source.ts` refuses when a failed snapshot stays `unknown` rather
 * than becoming an empty list.
 */
export type EpisodeProgress =
  | {
      readonly state: "in-progress";
      /**
       * How far through, 0..1, or `null` when the runtime is unknown.
       *
       * `null` IS NOT ZERO. A source that never reported a runtime has not said
       * the episode is at the beginning; it has said nothing, and
       * `progressViewSchema` keeps `runtimeSeconds` nullable for exactly that
       * reason. The renderer shows "In progress" without a bar.
       */
      readonly completedFraction: number | null;
    }
  | { readonly state: "watched" }
  | { readonly state: "unwatched" }
  | { readonly state: "unknown" };

/** Every episode's state, by content id. Absent means `unwatched`. */
export type EpisodeProgressIndex = ReadonlyMap<string, EpisodeProgress>;

/**
 * What the loader answers.
 *
 * `unavailable` CARRIES NO REASON CODE TO THE PAGE, deliberately. Every way
 * this read can fail -- no session, no profile chosen, no database, a limit
 * refusal, a driver exception -- means the same thing to an episode list: it
 * cannot say whether anything was watched. Putting an identity-store reason
 * code beside a list of episodes would be the catalog's internal vocabulary
 * leaking onto a title page, which `app/page.tsx` already refuses for its empty
 * states. The reason is still returned, for a diagnostic that wants it, and the
 * component does not render it.
 */
export type EpisodeProgressResult =
  | { readonly status: "ok"; readonly byContentId: EpisodeProgressIndex }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Turn stored rows into per-episode state.
 *
 * PURE, so the policy can be exercised without a database, which is the half
 * `episode-progress.test.ts` covers. The episode ids are passed in rather than
 * inferred from the rows: the page knows which episodes it is showing, and a
 * row for some other title must not produce an entry the renderer then cannot
 * place.
 */
export function indexEpisodeProgress(
  rows: readonly PlaybackProgressRow[],
  episodeIds: readonly string[]
): EpisodeProgressIndex {
  const wanted = new Set(episodeIds);
  const index = new Map<string, EpisodeProgress>();

  for (const row of rows) {
    if (!wanted.has(row.contentId)) continue;
    /* First write wins. `listContinueWatching` orders by `updated_at`
     * descending, so if a profile somehow has two rows for one content id the
     * newer one is the one that counts -- and taking the first is how that
     * order is honoured rather than re-sorted. */
    if (index.has(row.contentId)) continue;

    const verdict = continueWatchingVerdict(row);
    if (verdict.kind === "resumable") {
      index.set(row.contentId, {
        state: "in-progress",
        completedFraction: verdict.completedFraction
      });
      continue;
    }

    /*
     * THE THREE EXCLUSIONS DO NOT ALL MEAN THE SAME THING HERE, and the mapping
     * is where this module differs from the rail. The rail drops every one of
     * them; a list has to say something about each.
     *
     *   finished        -> watched. It is the only one that is a claim about
     *                      the viewer having seen it.
     *   barely_started  -> unwatched. Thirty seconds is a title sequence;
     *                      `RESUMABLE_MINIMUM_SECONDS` exists because opening a
     *                      title and leaving writes a row, and marking that
     *                      episode "in progress" would put a resume badge on
     *                      something nobody watched.
     *   not_started     -> unwatched. The row is a writer lease and nothing
     *                      more. `listContinueWatching` already excludes these
     *                      in SQL; the branch is kept because this function is
     *                      reachable from rows read by other means, which is
     *                      the same reason `continueWatchingVerdict` restates
     *                      the rule it is given.
     */
    index.set(row.contentId, verdict.why === "finished" ? { state: "watched" } : { state: "unwatched" });
  }

  return index;
}

/**
 * Read this profile's progress for the episodes on screen.
 *
 * NEVER THROWS. This runs inside a title page's render, and a page whose
 * failure mode is a stack trace is a page with no episode list on it. The
 * episodes are still listed and still playable without their badges; the state
 * is supplementary.
 *
 * HEADERS IN, NOT A `Request`, for the reason `loadContinueWatching` takes the
 * same: the session cookie and the two development headers are the only inputs
 * that decide anything on this path, and a server component holds `headers()`.
 *
 * IT DOES NOT NAME A PROFILE. `resolveActiveProfileScope` reads
 * `session.activeProfileId`, which is server-side state, and there is no
 * parameter here through which a caller could supply one -- the same absence
 * every other profile-scoped read in this application maintains.
 */
export async function loadEpisodeProgress(
  requestHeaders: Headers,
  episodeIds: readonly string[],
  options: { readonly limit?: number } = {}
): Promise<EpisodeProgressResult> {
  /* Nothing to ask about. Answered without touching the store, so a series
   * with no episodes costs no query. */
  if (episodeIds.length === 0) return { status: "ok", byContentId: new Map() };

  try {
    const context = await resolveRequestContext(
      new Request("http://episode-progress.invalid/", { headers: requestHeaders })
    );
    if (!context.ok) return { status: "unavailable", reason: context.reasons[0].code };

    const decision = await resolveActiveProfileScope(context.context);
    if (!decision.allowed) {
      /* Includes the ordinary case of a viewer who has not chosen a profile
       * yet. That is not an error and the page does not report it as one. */
      return { status: "unavailable", reason: decision.reason };
    }

    const rows = await context.context.repository.listContinueWatching({
      scope: decision.scope,
      limit: options.limit ?? EPISODE_PROGRESS_QUERY_LIMIT
    });
    if (isLimitRefusal(rows)) return { status: "unavailable", reason: rows.reason };

    return { status: "ok", byContentId: indexEpisodeProgress(rows, episodeIds) };
  } catch {
    /*
     * The thrown value's text is NOT published, for the reason
     * `loadContinueWatching` gives: a repository exception can carry a
     * connection string, and this value reaches a server-rendered page.
     */
    return { status: "unavailable", reason: "episode_progress_unavailable" };
  }
}

/**
 * The store answered with a refusal rather than rows.
 *
 * Narrowed by SHAPE rather than by `Array.isArray` alone, because
 * `Array.isArray` does not narrow a `readonly T[] | ListLimitRejection` union
 * on its false branch -- the member it leaves is still both.
 */
function isLimitRefusal(
  value: readonly PlaybackProgressRow[] | ListLimitRejection
): value is ListLimitRejection {
  return !Array.isArray(value);
}

/**
 * What one episode's badge says, or `null` for no badge at all.
 *
 * HERE RATHER THAN IN THE COMPONENT so the copy is testable and so the two
 * states that produce NO badge are stated once. `unwatched` and `unknown` both
 * render nothing, and they do it for different reasons that matter:
 * `unwatched` has nothing to report, and `unknown` must not report anything,
 * because a badge is a claim and this request has not earned one.
 */
export function episodeProgressLabel(progress: EpisodeProgress | undefined): string | null {
  if (progress === undefined) return null;
  switch (progress.state) {
    case "watched":
      return "Watched";
    case "in-progress":
      return progress.completedFraction === null
        ? "In progress"
        : `${String(Math.round(progress.completedFraction * 100))}% watched`;
    case "unwatched":
    case "unknown":
      return null;
  }
}
